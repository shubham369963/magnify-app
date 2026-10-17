import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { deleteDocumentVectors, queueName, redisConnection } from '../config/settings.js';
import { SupabaseService } from '../database/supabase.service.js';
import { ProjectsService } from '../project-service/projects.service.js';
import { DocumentsService } from './documents.service.js';
import type { Project } from '../entities/project.entity.js';
import type { ProjectDocument } from '../entities/project-document.entity.js';
import { DocumentProcessingStatus } from '../enums/document-processing-status.enum.js';
import { withOperationLog } from '../shared-utils/operation-logger.js';
import { getTraceContext } from '../observability/trace-context.js';
import { metrics } from '../observability/metrics.js';
import { deleteVectorIndexCheckpoint } from './vector-index-checkpoint.js';

const DEFAULT_MAX_PDF_SIZE_BYTES = 3 * 1024 * 1024;
const configuredMaxPdfSizeBytes = process.env.MAX_PDF_SIZE_BYTES?.trim();
export const MAX_PDF_SIZE_BYTES = configuredMaxPdfSizeBytes
  ? Number(configuredMaxPdfSizeBytes)
  : DEFAULT_MAX_PDF_SIZE_BYTES;
if (!Number.isSafeInteger(MAX_PDF_SIZE_BYTES) || MAX_PDF_SIZE_BYTES < 1) {
  throw new Error('MAX_PDF_SIZE_BYTES must be a positive integer.');
}
const maxPdfSizeLabel = `${Number((MAX_PDF_SIZE_BYTES / (1024 * 1024)).toFixed(2))} MB`;

interface ProjectIndexTreeStatus {
  project_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  generation: number;
  error_message: string | null;
  metadata: { stage?: string; percentage?: number; document_count?: number };
  updated_at: string;
}

@Injectable()
export class UploadService implements OnModuleDestroy {
  private readonly logger = new Logger(UploadService.name);
  private readonly queue = new Queue(queueName, {
    connection: redisConnection(),
  });

  constructor(
    @Inject(SupabaseService) private readonly supabase: SupabaseService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
  ) {}

  async upload(file: Express.Multer.File | undefined, ownerId: string, projectId: string) {
    const finish = metrics.startDependency('upload', 'request', file?.size ?? 0);
    try {
      const result = await withOperationLog(this.logger, 'document.upload.enqueue', {
        ownerId,
        projectId,
        fileSizeBytes: file?.size,
        traceId: getTraceContext()?.traceId,
        requestId: getTraceContext()?.requestId,
      }, () => this.performUpload(file, ownerId, projectId), (upload) => ({
        documentId: upload.documentId,
        jobId: upload.jobId,
      }));
      finish('success');
      metrics.observeUploadBytes('accepted', file?.size ?? 0);
      return result;
    } catch (error) {
      finish('error');
      throw error;
    }
  }

  private async performUpload(file: Express.Multer.File | undefined, ownerId: string, projectId: string) {
    if (!file?.buffer?.length) throw new BadRequestException('A PDF file is required.');
    if (file.size >= MAX_PDF_SIZE_BYTES || file.buffer.length >= MAX_PDF_SIZE_BYTES) {
      throw new BadRequestException(`PDF files must be smaller than ${maxPdfSizeLabel}.`);
    }
    if (file.buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new BadRequestException('The uploaded file is not a valid PDF.');
    }
    await this.projects.get(ownerId, projectId);

    const documentId = randomUUID();
    const traceId = getTraceContext()?.traceId ?? randomUUID();
    const requestId = getTraceContext()?.requestId;
    const originalName = basename(file.originalname).replace(/[\u0000-\u001f\\/]/g, '_').slice(0, 180) || 'document.pdf';
    const filename = originalName.toLowerCase().endsWith('.pdf') ? originalName : `${originalName}.pdf`;
    const storagePath = `${ownerId}/${projectId}/${documentId}/${filename}`;
    const checksum = createHash('sha256').update(file.buffer).digest('hex');
    let rowCreated = false;
    let objectCreated = false;
    let generation: number | undefined;
    try {
      await metrics.trackDependency('upload', 'storage_write', () =>
        this.supabase.uploadObject(storagePath, file.buffer, 'application/pdf'), file.size);
      objectCreated = true;
      await metrics.trackDependency('upload', 'document_row_insert', () => this.supabase.insert('documents', {
        id: documentId,
        owner_clerk_id: ownerId,
        project_id: projectId,
        file_name: filename,
        storage_path: storagePath,
        mime_type: 'application/pdf',
        file_size: file.size,
        checksum,
        processing_status: DocumentProcessingStatus.Pending,
      }));
      rowCreated = true;
      generation = await this.requestProjectTreeGeneration(ownerId, projectId);
      const job = await metrics.trackDependency('upload', 'indexing_job_enqueue', () => this.queue.add('document-index', { documentId, projectId, ownerId, traceId, requestId }, {
        jobId: documentId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      }));
      return { message: 'uploaded', documentId, jobId: job.id };
    } catch (error) {
      if (generation !== undefined) {
        await this.logCleanupFailure('mark project index enqueue as failed', () => this.supabase.rpc('fail_project_index_tree', {
          p_project_id: projectId,
          p_owner_clerk_id: ownerId,
          p_generation: generation,
          p_error_message: 'Could not enqueue document indexing.',
        }));
      }
      if (rowCreated) {
        await this.logCleanupFailure('remove document row after upload failure', () =>
          this.supabase.delete('documents', new URLSearchParams({ id: `eq.${documentId}`, owner_clerk_id: `eq.${ownerId}` })));
      }
      if (objectCreated) {
        await this.logCleanupFailure('remove uploaded PDF after upload failure', () => this.supabase.deleteObject(storagePath));
      }
      throw error;
    }
  }

  async getStatus(jobId: string, ownerId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
      throw new NotFoundException('Upload job not found.');
    }
    const job = await this.queue.getJob(jobId);
    const documents = await this.supabase.select<ProjectDocument>(
      'documents',
      new URLSearchParams({ id: `eq.${jobId}`, owner_clerk_id: `eq.${ownerId}`, select: '*', limit: '1' }),
    );
    const document = documents[0];
    if (job && job.data.ownerId !== ownerId) throw new NotFoundException('Upload job not found.');
    // The job id is the document id, so a missing row means the PDF was deleted.
    if (!document) {
      const progress = job?.progress as { stage?: unknown; error?: unknown } | undefined;
      // Quota failures remove the PDF but leave the reason on the job so the UI can show it.
      if (typeof progress === 'object' && progress !== null
        && progress.stage === 'failed' && typeof progress.error === 'string') {
        return { jobId, status: 'failed', progress: null, error: progress.error };
      }
      return { jobId, status: 'deleted', progress: null };
    }
    const state = job ? await job.getState() : document.processing_status;
    const status = state === 'completed'
      ? document.processing_status === DocumentProcessingStatus.Completed
        ? 'completed'
        : document.processing_status === DocumentProcessingStatus.Failed ? 'failed' : 'processing'
      : state === 'failed'
        ? 'failed'
        : state === 'active' || state === 'processing'
          ? 'processing'
          : 'queued';

    return {
      jobId,
      status,
      progress: job?.progress ?? null,
      ...(status === 'failed' ? { error: document.processing_error || 'PDF processing failed.' } : {}),
    };
  }

  async deleteDocument(ownerId: string, projectId: string, documentId: string): Promise<void> {
    return withOperationLog(this.logger, 'document.delete', { ownerId, projectId, documentId }, () =>
      this.performDocumentDeletion(ownerId, projectId, documentId));
  }

  private async performDocumentDeletion(ownerId: string, projectId: string, documentId: string): Promise<void> {
    await this.projects.get(ownerId, projectId);
    const document = await this.documents.get(ownerId, projectId, documentId);
    await this.requestProjectTreeGeneration(ownerId, projectId);
    await this.cancelProjectDocumentJobs(projectId, documentId);
    try {
      await deleteDocumentVectors(documentId);
      await this.supabase.deleteObject(document.storage_path);
      await this.documents.removeRow(ownerId, projectId, documentId);
      await this.logCleanupFailure('remove deleted document vector checkpoint', () =>
        deleteVectorIndexCheckpoint(documentId));
    } catch (error) {
      await this.logCleanupFailure('reschedule project index after document deletion failure', () =>
        this.scheduleProjectTree(ownerId, projectId));
      throw error;
    }
    const remaining = await this.listProjectDocumentIds(ownerId, projectId);
    if (remaining.length) await this.scheduleProjectTree(ownerId, projectId);
    else await this.supabase.delete('project_index_trees', new URLSearchParams({
      project_id: `eq.${projectId}`,
      owner_clerk_id: `eq.${ownerId}`,
    }));
  }

  async updateStrategy(
    ownerId: string,
    projectId: string,
    strategy: Project['rag_strategy'],
    otherValues: Record<string, unknown> = {},
  ): Promise<Project> {
    return this.projects.update(ownerId, projectId, { ...otherValues, ragStrategy: strategy });
  }

  async getProjectTreeStatus(ownerId: string, projectId: string): Promise<ProjectIndexTreeStatus | null> {
    await this.projects.get(ownerId, projectId);
    const rows = await this.supabase.select<ProjectIndexTreeStatus>('project_index_trees', new URLSearchParams({
      project_id: `eq.${projectId}`,
      owner_clerk_id: `eq.${ownerId}`,
      select: 'project_id,status,generation,error_message,metadata,updated_at',
      limit: '1',
    }));
    return rows[0] ?? null;
  }

  async reindexProjectTree(ownerId: string, projectId: string) {
    return withOperationLog(this.logger, 'project.index.reindex.enqueue', { ownerId, projectId }, () =>
      this.enqueueProjectTreeReindex(ownerId, projectId));
  }

  private async enqueueProjectTreeReindex(ownerId: string, projectId: string) {
    const project = await this.projects.get(ownerId, projectId);
    if (project.rag_strategy !== 'index_tree') throw new BadRequestException('Select Vectorless Index-Tree RAG before reindexing.');
    const documents = await this.listProjectDocumentIds(ownerId, projectId);
    if (!documents.length) throw new BadRequestException('Upload a PDF before building the project index.');
    return this.scheduleProjectTree(ownerId, projectId);
  }

  async onModuleDestroy() {
    await this.queue.close();
  }

  private async listProjectDocumentIds(ownerId: string, projectId: string) {
    return this.supabase.select<Pick<ProjectDocument, 'id'>>('documents', new URLSearchParams({
      project_id: `eq.${projectId}`,
      owner_clerk_id: `eq.${ownerId}`,
      select: 'id',
      order: 'created_at.asc',
    }));
  }

  private async requestProjectTreeGeneration(ownerId: string, projectId: string): Promise<number> {
    return this.supabase.rpc<number>('request_project_index_tree', {
      p_project_id: projectId,
      p_owner_clerk_id: ownerId,
    });
  }

  private async scheduleProjectTree(
    ownerId: string,
    projectId: string,
    documentId?: string,
    traceId = getTraceContext()?.traceId,
    requestId = getTraceContext()?.requestId,
  ) {
    return withOperationLog(this.logger, 'project.index.enqueue', {
      ownerId,
      projectId,
      documentId,
    }, () => this.enqueueProjectTree(ownerId, projectId, documentId, traceId, requestId), (job) => ({ jobId: job.id }));
  }

  private async enqueueProjectTree(
    ownerId: string,
    projectId: string,
    documentId?: string,
    traceId?: string,
    requestId?: string,
  ) {
    const generation = await this.requestProjectTreeGeneration(ownerId, projectId);
    const jobId = `project-tree-${projectId}-${generation}-${randomUUID()}`;
    try {
      return await this.queue.add('project-index-tree', { documentId, projectId, ownerId, generation, traceId, requestId }, {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      });
    } catch (error) {
      await this.logCleanupFailure('mark project index as failed after enqueue failure', () => this.supabase.rpc('fail_project_index_tree', {
        p_project_id: projectId,
        p_owner_clerk_id: ownerId,
        p_generation: generation,
        p_error_message: 'Could not enqueue project index job.',
      }));
      throw error;
    }
  }

  /** Removes queued and retained BullMQ jobs for a deleted account; active jobs stop on their own. */
  async removeOwnerJobs(ownerId: string): Promise<void> {
    const jobs = await this.queue.getJobs(['waiting', 'delayed', 'paused', 'prioritized', 'waiting-children', 'completed', 'failed']);
    await Promise.all(jobs
      .filter((job) => job?.data?.ownerId === ownerId)
      .map((job) => this.logCleanupFailure('remove deleted account job', () => job.remove())));
  }

  private async cancelProjectDocumentJobs(projectId: string, documentId: string): Promise<void> {
    const documentJob = await this.queue.getJob(documentId);
    if (documentJob) {
      await this.logCleanupFailure('remove queued document job', async () => {
        if (await documentJob.getState() !== 'active') await documentJob.remove();
      });
    }
    const waitingJobs = await this.queue.getJobs(['waiting', 'delayed', 'paused']);
    await Promise.all(waitingJobs
      .filter((job) => job.data?.projectId === projectId && job.data?.documentId === documentId)
      .map((job) => this.logCleanupFailure('remove queued project index job', () => job.remove())));
  }

  private async logCleanupFailure(action: string, cleanup: () => Promise<unknown>): Promise<void> {
    try {
      await cleanup();
    } catch (cleanupError) {
      const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      this.logger.warn(`Could not ${action}: ${detail}`);
    }
  }
}
