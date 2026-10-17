import { Inject, Injectable, Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { Document } from '@langchain/core/documents';
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import { QdrantVectorStore } from '@langchain/qdrant';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { collectionName, createQdrantClient, deleteDocumentVectors, ensureQdrantPayloadIndexes } from '../config/settings.js';
import { createOllamaCloudVisionModel } from '../config/ollama-cloud.js';
import { GeminiEmbeddings } from '../config/gemini-embeddings.js';
import { isProviderQuotaFailure, ProviderQuotaError } from '../shared-utils/provider-quota-error.js';
import { SupabaseService } from '../database/supabase.service.js';
import type { ProjectDocument } from '../entities/project-document.entity.js';
import { DocumentProcessingStatus } from '../enums/document-processing-status.enum.js';
import { selectImagePages, splitPageText, stableVectorPointId } from './pdf-chunking.utils.js';
import { createDocumentTreeNode, linkAdjacentTreeEvidence, normalizeStructuredPageText, selectTreeDocuments, validateProjectIndexTree, type ProjectIndexTreeNode } from './index-tree.utils.js';
import { metrics, type IngestionStrategy } from '../observability/metrics.js';
import { withOperationLog } from '../shared-utils/operation-logger.js';
import { deleteVectorIndexCheckpoint, loadVectorIndexCheckpoint, saveVectorIndexCheckpoint } from './vector-index-checkpoint.js';
import { readPdfProcessingSettings } from '../config/pdf-processing.js';
import { PdfImageProcessor } from './pdf-image-processing.js';

export interface UploadJobData {
  documentId: string;
  projectId: string;
  ownerId: string;
  strategy?: 'vector' | 'index_tree';
  generation?: number;
  traceId?: string;
  requestId?: string;
}

export interface ProjectTreeJobData {
  documentId?: string;
  projectId: string;
  ownerId: string;
  generation: number;
  traceId?: string;
  requestId?: string;
}

export interface IndexingProgress {
  stage: 'loading' | 'captioning' | 'building_tree' | 'embedding' | 'storing' | 'completed' | 'failed';
  percentage: number;
  error?: string;
}

export const QUOTA_REMOVAL_MESSAGE_SUFFIX = 'The PDF was removed. Wait for the quota to reset or increase it, then upload the PDF again.';

const execFileAsync = promisify(execFile);
const DOCUMENT_EXISTENCE_CHECK_INTERVAL_MS = 5000;

export class DocumentRemovedError extends UnrecoverableError {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentRemovedError';
  }
}

@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);
  private readonly qdrantClient = createQdrantClient();
  private vectorStorePromise?: Promise<QdrantVectorStore>;
  private embeddingModel?: GeminiEmbeddings;
  private payloadIndexesPromise?: Promise<void>;
  private readonly pdfSettings = readPdfProcessingSettings();
  private readonly imageProcessor = new PdfImageProcessor(this.pdfSettings.imageConcurrency, this.pdfSettings.renderConcurrency);
  private get visionModel() {
    return createOllamaCloudVisionModel();
  }

  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService) {}

  async process(upload: UploadJobData, reportProgress?: (progress: IndexingProgress) => Promise<void>) {
    return withOperationLog(this.logger, 'document.processing', {
      documentId: upload.documentId,
      projectId: upload.projectId,
      strategy: 'both',
    }, () => this.processUpload(upload, reportProgress));
  }

  private async processUpload(upload: UploadJobData, reportProgress?: (progress: IndexingProgress) => Promise<void>) {
    const documentRows = await this.supabase.select<ProjectDocument>(
      'documents',
      new URLSearchParams({
        id: `eq.${upload.documentId}`,
        project_id: `eq.${upload.projectId}`,
        owner_clerk_id: `eq.${upload.ownerId}`,
        select: '*',
        limit: '1',
      }),
    );
    const document = documentRows[0];
    if (!document) {
      await deleteVectorIndexCheckpoint(upload.documentId);
      throw new DocumentRemovedError('PDF was removed before indexing started.');
    }

    let lastExistenceCheck = Date.now();
    const assertNotRemoved = async (force = false) => {
      if (!force && Date.now() - lastExistenceCheck < DOCUMENT_EXISTENCE_CHECK_INTERVAL_MS) return;
      lastExistenceCheck = Date.now();
      await this.assertDocumentExists(upload);
    };
    const ingestion = metrics.startIngestion('both');
    metrics.addIngestionUnits('both', 'documents');
    let tempDirectory: string | undefined;
    let committed = false;
    try {
      await this.setStatus(upload, DocumentProcessingStatus.Processing, null);
      let docs: Document[];
      let documentNode: ProjectIndexTreeNode;
      const checkpointIdentity = {
        documentId: document.id,
        projectId: document.project_id,
        ownerId: document.owner_clerk_id,
        storagePath: document.storage_path,
      };
      const checkpoint = await loadVectorIndexCheckpoint(checkpointIdentity);
      if (checkpoint?.documentNode) {
        docs = checkpoint.documents.map((item) => new Document(item));
        documentNode = checkpoint.documentNode;
        this.logger.log(JSON.stringify({
          event: 'document.processing.resume',
          documentId: document.id,
          projectId: document.project_id,
          stage: 'indexing_both',
          passageCount: docs.length,
        }));
      } else {
        const tempDirectoryPath = await mkdtemp(join(tmpdir(), 'magnify-pdf-'));
        tempDirectory = tempDirectoryPath;
        const pdfPath = join(tempDirectoryPath, 'document.pdf');
        await reportProgress?.({ stage: 'loading', percentage: 5 });
        const file = await metrics.trackStage('both', 'storage_download', () => this.supabase.downloadObject(document.storage_path));
        await writeFile(pdfPath, file, { flag: 'wx' });
        const loader = new PDFLoader(pdfPath);
        const pages = await metrics.trackStage('both', 'pdf_text_extraction', () => loader.load());
        metrics.addIngestionUnits('both', 'pages', pages.length);
        docs = metrics.trackStageSync('vector', 'chunking', () => {
          return pages.flatMap((page, index) => {
            const pageNumber = Number(page.metadata.loc?.pageNumber) || index + 1;
            return splitPageText(page.pageContent).map((pageContent, chunkIndex) => new Document({
              pageContent,
              metadata: {
                ...page.metadata,
                page_number: pageNumber,
                chunk_index: chunkIndex + 1,
                source: document.file_name,
                document_id: document.id,
                project_id: document.project_id,
                owner_clerk_id: document.owner_clerk_id,
                content_type: 'text',
              },
            }));
          });
        });
        const { stdout: imageListing } = await metrics.trackStage('both', 'image_discovery', () =>
          execFileAsync('pdfimages', ['-list', pdfPath], { maxBuffer: 10 * 1024 * 1024 }));
        const imagePages = this.selectCaptionPages(imageListing, 'both', document.id);
        await assertNotRemoved(true);
        await reportProgress?.({ stage: 'captioning', percentage: 20 });
        const captions = await this.captionImagePages(
          imagePages, pdfPath, tempDirectoryPath, 'both',
          async (completed) => {
            // Stop spending vision-model calls once the user deletes the PDF.
            await assertNotRemoved();
            await reportProgress?.({
              stage: 'captioning',
              percentage: 20 + Math.floor((completed / imagePages.length) * 35),
            });
          },
        );
        await assertNotRemoved(true);
        for (const { pageNumber, caption } of captions) {
          if (caption) {
            const page = pages[pageNumber - 1];
            docs.push(new Document({
              pageContent: caption,
              metadata: {
                ...page?.metadata,
                page_number: pageNumber,
                chunk_index: 0,
                source: document.file_name,
                document_id: document.id,
                project_id: document.project_id,
                owner_clerk_id: document.owner_clerk_id,
                content_type: 'image_caption',
                loc: page?.metadata.loc ?? { pageNumber },
              },
            }));
          }
        }
        await reportProgress?.({ stage: 'building_tree', percentage: 60 });
        documentNode = metrics.trackStageSync('index_tree', 'tree_generation', () => createDocumentTreeNode(
          document,
          pages.flatMap((page, index) => normalizeStructuredPageText(page.pageContent)
            ? [{ pageNumber: Number(page.metadata.loc?.pageNumber) || index + 1, text: page.pageContent }]
            : []),
          captions,
        ));
        await saveVectorIndexCheckpoint({
          ...checkpointIdentity,
          documents: docs.map(({ pageContent, metadata }) => ({ pageContent, metadata })),
          documentNode,
        });
      }
      this.validateDocumentNode(documentNode, document.id);
      metrics.addIngestionUnits('index_tree', 'passages', countTreeNodes(documentNode, 'passage'));
      metrics.addIngestionUnits('vector', 'passages', docs.length);
      const vectorStore = await metrics.trackStage('vector', 'vector_store_setup', async () => {
        const store = await this.getVectorStore();
        await this.ensurePayloadIndexes();
        return store;
      });
      await this.assertDocumentExists(upload);
      await deleteDocumentVectors(document.id);
      await reportProgress?.({ stage: 'embedding', percentage: 65 });
      if (docs.length) {
        const vectors = await metrics.trackStage('vector', 'embedding', () => this.getEmbeddings().embedDocuments(
          docs.map((doc) => doc.pageContent),
          {
            checkpoint: checkpoint?.documentNode ? checkpoint.embeddings : undefined,
            saveCheckpoint: async (embeddings) => {
              await this.assertDocumentExists(upload);
              await saveVectorIndexCheckpoint({
                ...checkpointIdentity,
                documents: docs.map(({ pageContent, metadata }) => ({ pageContent, metadata })),
                documentNode,
                embeddings,
              });
              try {
                await this.assertDocumentExists(upload);
              } catch (error) {
                if (error instanceof DocumentRemovedError) await deleteVectorIndexCheckpoint(document.id);
                throw error;
              }
            },
          },
        ));
        await this.assertDocumentExists(upload);
        const pointIds = docs.map((doc, index) => stableVectorPointId(
          document.id,
          Number(doc.metadata.page_number) || index + 1,
          String(doc.metadata.content_type ?? 'text'),
          doc.pageContent,
        ));
        try {
          await metrics.trackDependency('qdrant', 'upsert', () => vectorStore.addVectors(vectors, docs, { ids: pointIds }));
          metrics.observeVectorOperation('vector_write', 'success');
        } catch (error) {
          metrics.observeVectorOperation('vector_write', 'error');
          throw error;
        }
      }
      await this.assertDocumentExists(upload);
      await reportProgress?.({ stage: 'storing', percentage: 90 });
      await metrics.trackStage('index_tree', 'tree_persistence', () => this.supabase.rpc('complete_document_indexing', {
        p_project_id: upload.projectId,
        p_owner_clerk_id: upload.ownerId,
        p_document_id: document.id,
        p_document_node: documentNode,
      }));
      committed = true;
      await reportProgress?.({ stage: 'completed', percentage: 100 });
      await this.logCleanupFailure('remove completed vector indexing checkpoint', () =>
        deleteVectorIndexCheckpoint(document.id));
      ingestion.setOutcome('success');
    } catch (caught) {
      const error = !(caught instanceof ProviderQuotaError) && isProviderQuotaFailure(caught)
        ? new ProviderQuotaError('AI provider', caught instanceof Error ? caught.message : String(caught))
        : caught;
      if (!committed && error instanceof ProviderQuotaError) {
        await this.discardQuotaFailedDocument(upload, document, error, reportProgress);
        throw error;
      }
      if (!committed) {
        await this.logCleanupFailure('delete partial document vectors', () => deleteDocumentVectors(document.id));
        await this.logCleanupFailure('mark combined document indexing as failed', () =>
          this.supabase.rpc('fail_document_indexing', {
            p_project_id: upload.projectId,
            p_owner_clerk_id: upload.ownerId,
            p_document_id: document.id,
            p_error_message: 'PDF indexing failed. Please retry the upload.',
          }));
        if (error instanceof DocumentRemovedError) {
          await this.logCleanupFailure('remove deleted document vector checkpoint', () =>
            deleteVectorIndexCheckpoint(document.id));
        }
      }
      throw error;
    } finally {
      try {
        if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
      } finally {
        ingestion.finish();
      }
    }
  }

  /** Quota failures stop indexing and remove the upload; the job progress keeps the reason for the UI. */
  private async discardQuotaFailedDocument(
    upload: UploadJobData,
    document: ProjectDocument,
    error: ProviderQuotaError,
    reportProgress?: (progress: IndexingProgress) => Promise<void>,
  ) {
    const message = `${error.message} ${QUOTA_REMOVAL_MESSAGE_SUFFIX}`;
    this.logger.warn(JSON.stringify({
      event: 'document.processing.quota_exceeded',
      documentId: document.id,
      projectId: document.project_id,
      provider: error.provider,
      detail: error.detail?.slice(0, 500),
    }));
    await this.logCleanupFailure('record quota failure for the upload status', async () =>
      reportProgress?.({ stage: 'failed', percentage: 0, error: message }));
    try {
      await this.supabase.rpc('discard_document_indexing', {
        p_project_id: upload.projectId,
        p_owner_clerk_id: upload.ownerId,
        p_document_id: document.id,
      });
    } catch (removalError) {
      const detail = removalError instanceof Error ? removalError.message : String(removalError);
      this.logger.warn(`Could not remove quota-failed document: ${detail}`);
      await this.logCleanupFailure('mark quota-failed document as failed', () => this.supabase.rpc('fail_document_indexing', {
        p_project_id: upload.projectId,
        p_owner_clerk_id: upload.ownerId,
        p_document_id: document.id,
        p_error_message: error.message,
      }));
      await this.logCleanupFailure('delete partial document vectors', () => deleteDocumentVectors(document.id));
      return;
    }
    await Promise.all([
      this.logCleanupFailure('delete quota-failed document vectors', () => deleteDocumentVectors(document.id)),
      this.logCleanupFailure('delete quota-failed PDF', () => this.supabase.deleteObject(document.storage_path)),
      this.logCleanupFailure('remove quota-failed checkpoint', () => deleteVectorIndexCheckpoint(document.id)),
    ]);
  }

  private validateDocumentNode(documentNode: ProjectIndexTreeNode, documentId: string) {
    validateProjectIndexTree({
      id: 'validation-root',
      type: 'root',
      title: 'Document index',
      source_document_ids: [documentId],
      children: [documentNode],
    }, [documentId]);
  }

  async processProjectTree(
    upload: ProjectTreeJobData,
    reportProgress?: (progress: IndexingProgress) => Promise<void>,
  ): Promise<void> {
    return withOperationLog(this.logger, 'project.index.processing', {
      projectId: upload.projectId,
      documentId: upload.documentId,
      generation: upload.generation,
    }, () => this.processProjectTreeJob(upload, reportProgress));
  }

  private async processProjectTreeJob(
    upload: ProjectTreeJobData,
    reportProgress?: (progress: IndexingProgress) => Promise<void>,
  ): Promise<void> {
    const filter = new URLSearchParams({
      project_id: `eq.${upload.projectId}`,
      owner_clerk_id: `eq.${upload.ownerId}`,
    });
    const treeRows = await this.supabase.select<{ generation: number; tree?: ProjectIndexTreeNode }>(
      'project_index_trees',
      new URLSearchParams({ ...Object.fromEntries(filter), select: 'generation,tree', limit: '1' }),
    );
    if (treeRows[0]?.generation !== upload.generation) return;

    const projectRows = await this.supabase.select<{ id: string; name: string }>(
      'projects',
      new URLSearchParams({ id: `eq.${upload.projectId}`, owner_clerk_id: `eq.${upload.ownerId}`, select: 'id,name', limit: '1' }),
    );
    const project = projectRows[0];
    if (!project) return;

    const documents = await this.supabase.select<ProjectDocument>(
      'documents',
      new URLSearchParams({
        project_id: `eq.${upload.projectId}`,
        owner_clerk_id: `eq.${upload.ownerId}`,
        select: '*',
        order: 'created_at.asc',
      }),
    );
    if (!documents.length) {
      await this.supabase.delete('project_index_trees', new URLSearchParams({
        project_id: `eq.${upload.projectId}`,
        owner_clerk_id: `eq.${upload.ownerId}`,
        generation: `eq.${upload.generation}`,
      }));
      return;
    }

    const previousDocumentNodes = (treeRows[0].tree?.children ?? [])
      .filter((node) => node.type === 'document' && typeof node.document_id === 'string');
    const indexedDocumentIds = new Set(previousDocumentNodes.map((node) => node.document_id!));
    const documentsToProcess = selectTreeDocuments(documents, indexedDocumentIds, upload.documentId);
    const processingDocumentIds = new Set(documentsToProcess.map((document) => document.id));
    const currentDocumentIds = new Set(documents.map((document) => document.id));
    const documentNodes: ProjectIndexTreeNode[] = previousDocumentNodes
      .filter((node) => currentDocumentIds.has(node.document_id!) && !processingDocumentIds.has(node.document_id!))
      .map((node) => ({ ...node }));

    await this.supabase.update('project_index_trees', new URLSearchParams({
      project_id: `eq.${upload.projectId}`,
      owner_clerk_id: `eq.${upload.ownerId}`,
      generation: `eq.${upload.generation}`,
    }), { status: 'processing', error_message: null, updated_at: new Date().toISOString() });
    const sendProgress = async (progress: IndexingProgress) => {
      await reportProgress?.(progress);
      await this.supabase.update('project_index_trees', new URLSearchParams({
        project_id: `eq.${upload.projectId}`,
        owner_clerk_id: `eq.${upload.ownerId}`,
        generation: `eq.${upload.generation}`,
      }), { metadata: { stage: progress.stage, percentage: progress.percentage, document_count: documents.length } });
    };

    const ingestion = metrics.startIngestion('index_tree');
    metrics.addIngestionUnits('index_tree', 'documents', documentsToProcess.length);
    const temporaryDirectories: string[] = [];
    try {
      for (const [documentIndex, document] of documentsToProcess.entries()) {
        await sendProgress({ stage: 'loading', percentage: Math.floor((documentIndex / documentsToProcess.length) * 20) });
        const directory = await mkdtemp(join(tmpdir(), 'magnify-index-tree-'));
        temporaryDirectories.push(directory);
        const pdfPath = join(directory, 'document.pdf');
        const pdfFile = await metrics.trackStage('index_tree', 'storage_download', () => this.supabase.downloadObject(document.storage_path));
        await writeFile(pdfPath, pdfFile, { flag: 'wx' });
        const loadedPages = await metrics.trackStage('index_tree', 'pdf_text_extraction', () => new PDFLoader(pdfPath).load());
        metrics.addIngestionUnits('index_tree', 'pages', loadedPages.length);
        const pages = loadedPages.flatMap((page, index) => {
          const text = normalizeStructuredPageText(page.pageContent);
          return text ? [{ pageNumber: Number(page.metadata.loc?.pageNumber) || index + 1, text: page.pageContent }] : [];
        });
        const { stdout: imageListing } = await metrics.trackStage('index_tree', 'image_discovery', () =>
          execFileAsync('pdfimages', ['-list', pdfPath], { maxBuffer: 10 * 1024 * 1024 }));
        const imagePages = this.selectCaptionPages(imageListing, 'index_tree', document.id);
        const captions = await this.captionImagePages(imagePages, pdfPath, directory, 'index_tree');
        const documentNode = metrics.trackStageSync('index_tree', 'tree_generation', () =>
          createDocumentTreeNode(document, pages, captions));
        metrics.addIngestionUnits('index_tree', 'passages', countTreeNodes(documentNode, 'passage'));
        await sendProgress({
          stage: 'building_tree',
          percentage: 20 + Math.floor(((documentIndex + 1) / documentsToProcess.length) * 65),
        });
        documentNodes.push(documentNode);
      }

      const latestRows = await this.supabase.select<{ generation: number }>(
        'project_index_trees',
        new URLSearchParams({ ...Object.fromEntries(filter), select: 'generation', limit: '1' }),
      );
      if (latestRows[0]?.generation !== upload.generation) {
        ingestion.setOutcome('stale');
        return;
      }
      const tree = {
        id: `project-${project.id}`,
        type: 'root',
        title: `${project.name} index`,
        summary: `Combined index for ${documents.length} project PDFs.`,
        source_document_ids: documents.map((document) => document.id),
        children: documentNodes,
      };
      const serializedTree = JSON.stringify(tree);
      metrics.observeIndexTreeShape(countTreeNodes(tree), Buffer.byteLength(serializedTree));
      for (const document of documentNodes) {
        const evidence: ProjectIndexTreeNode[] = [];
        const pendingSections = [...(document.children ?? [])];
        for (let index = 0; index < pendingSections.length; index += 1) {
          const section = pendingSections[index];
          for (const child of section.children ?? []) {
            if (child.type === 'passage') evidence.push(child);
            else pendingSections.push(child);
          }
        }
        linkAdjacentTreeEvidence(evidence);
      }
      validateProjectIndexTree(tree, tree.source_document_ids);
      await metrics.trackStage('index_tree', 'tree_persistence', () => this.supabase.rpc('save_project_index_tree', {
        p_project_id: upload.projectId,
        p_owner_clerk_id: upload.ownerId,
        p_generation: upload.generation,
        p_tree: tree,
        p_source_document_ids: tree.source_document_ids,
        p_metadata: {
          document_count: documents.length,
          passage_count: documentNodes.reduce((count, document) => count
            + (document.children ?? []).reduce((sectionCount, section) => sectionCount + (section.children?.length ?? 0), 0), 0),
        },
      }));
      await sendProgress({ stage: 'completed', percentage: 100 });
      ingestion.setOutcome('success');
    } catch (error) {
      const latestRows = await this.supabase.select<{ generation: number }>(
        'project_index_trees',
        new URLSearchParams({ ...Object.fromEntries(filter), select: 'generation', limit: '1' }),
      ).catch((lookupError: unknown) => {
        const detail = lookupError instanceof Error ? lookupError.message : String(lookupError);
        this.logger.warn(`Could not verify project index generation after processing failure: ${detail}`);
        return [];
      });
      if (latestRows[0]?.generation === upload.generation) {
        const message = error instanceof Error ? error.message : 'Project index creation failed.';
        await this.logCleanupFailure('mark project index generation as failed', () => this.supabase.rpc('fail_project_index_tree', {
          p_project_id: upload.projectId,
          p_owner_clerk_id: upload.ownerId,
          p_generation: upload.generation,
          p_error_message: message,
        }));
        throw error;
      }
      ingestion.setOutcome('stale');
    } finally {
      try {
        await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
      } finally {
        ingestion.finish();
      }
    }
  }

  async markProjectTreeJobFailed(upload: ProjectTreeJobData, error: Error): Promise<void> {
    return withOperationLog(this.logger, 'project.index.failure.finalize', {
      projectId: upload.projectId,
      generation: upload.generation,
    }, () => this.finalizeProjectTreeFailure(upload, error));
  }

  private async finalizeProjectTreeFailure(upload: ProjectTreeJobData, error: Error): Promise<void> {
    const rows = await this.supabase.select<{ generation: number }>(
      'project_index_trees',
      new URLSearchParams({
        project_id: `eq.${upload.projectId}`,
        owner_clerk_id: `eq.${upload.ownerId}`,
        select: 'generation',
        limit: '1',
      }),
    );
    if (rows[0]?.generation !== upload.generation) return;

    const message = error.message || 'Project index creation failed.';
    await this.supabase.rpc('fail_project_index_tree', {
      p_project_id: upload.projectId,
      p_owner_clerk_id: upload.ownerId,
      p_generation: upload.generation,
      p_error_message: message,
    });
  }

  private async setStatus(upload: UploadJobData, status: ProjectDocument['processing_status'], error: string | null) {
    await this.supabase.update<ProjectDocument>(
      'documents',
      new URLSearchParams({
        id: `eq.${upload.documentId}`,
        project_id: `eq.${upload.projectId}`,
        owner_clerk_id: `eq.${upload.ownerId}`,
      }),
      { processing_status: status, processing_error: error, updated_at: new Date().toISOString() },
    );
  }

  private selectCaptionPages(imageListing: string, strategy: IngestionStrategy, documentId: string): number[] {
    const selection = selectImagePages(imageListing, this.pdfSettings.imageFilter);
    metrics.addIngestionUnits(strategy, 'image_pages', selection.pages.length);
    metrics.addIngestionUnits(strategy, 'skipped_images', selection.skippedImages);
    this.logger.log(JSON.stringify({
      event: 'document.processing.image_pages_selected',
      strategy,
      documentId,
      images: selection.images,
      skippedImages: selection.skippedImages,
      imagePages: selection.pages.length,
    }));
    return selection.pages;
  }

  private async captionImagePages(
    pageNumbers: number[],
    pdfPath: string,
    directory: string,
    strategy: IngestionStrategy,
    onProgress?: (completed: number) => Promise<void>,
  ) {
    return metrics.trackStage(strategy, 'image_captioning', () => this.imageProcessor.process(
      pageNumbers,
      async (pageNumber) => {
        const imagePrefix = join(directory, `page-${pageNumber}`);
        return metrics.trackStage(strategy, 'image_rendering', async () => {
          await execFileAsync('pdftoppm', [
            '-f', String(pageNumber), '-l', String(pageNumber), '-singlefile',
            '-scale-to', '1024', '-png', pdfPath, imagePrefix,
          ]);
          const imagePath = `${imagePrefix}.png`;
          const image = await readFile(imagePath);
          await rm(imagePath);
          return image;
        });
      },
      async (image) => {
        const caption = await metrics.trackModelCall(strategy, 'image_caption', () => this.captionImage(image))
          .catch((error: unknown) => {
            if (isProviderQuotaFailure(error) && !(error instanceof ProviderQuotaError)) {
              throw new ProviderQuotaError('Image captioning', error instanceof Error ? error.message : String(error));
            }
            throw error;
          });
        if (caption) metrics.addIngestionUnits(strategy, 'image_captions');
        return caption;
      },
      onProgress,
    ));
  }

  private async captionImage(image: Buffer): Promise<string> {
    const response = await this.visionModel.invoke([
      new SystemMessage('Describe visual information accurately and concisely. Identify distinct figures separately, preserve their exact titles and visible labels, and do not infer details that are not visible or blend separate visuals together.'),
      new HumanMessage({ content: [
        { type: 'text', text: 'Describe each diagram, chart, screenshot, table, or other visual on this PDF page. Include the specific subject, exact visible labels, and important relationships so a later search can distinguish this visual from other figures.' },
        { type: 'image_url', image_url: `data:image/png;base64,${image.toString('base64')}` },
      ] }),
    ]);
    return typeof response.content === 'string' ? response.content.trim() : JSON.stringify(response.content);
  }

  private async getVectorStore(): Promise<QdrantVectorStore> {
    if (!this.vectorStorePromise) {
      this.vectorStorePromise = metrics.trackDependency('qdrant', 'collection_initialize', () =>
        QdrantVectorStore.fromExistingCollection(
          this.getEmbeddings(),
          { client: this.qdrantClient, collectionName },
        ));
    }
    try {
      return await this.vectorStorePromise;
    } catch (error) {
      this.vectorStorePromise = undefined;
      throw error;
    }
  }

  private getEmbeddings(): GeminiEmbeddings {
    this.embeddingModel ??= new GeminiEmbeddings();
    return this.embeddingModel;
  }

  private async ensurePayloadIndexes(): Promise<void> {
    if (!this.payloadIndexesPromise) {
      this.payloadIndexesPromise = metrics.trackDependency('qdrant', 'payload_index_setup', () =>
        ensureQdrantPayloadIndexes(this.qdrantClient));
    }
    try {
      await this.payloadIndexesPromise;
    } catch (error) {
      this.payloadIndexesPromise = undefined;
      throw error;
    }
  }

  private async assertDocumentExists(upload: UploadJobData): Promise<void> {
    const rows = await this.supabase.select<ProjectDocument>(
      'documents',
      new URLSearchParams({
        id: `eq.${upload.documentId}`,
        project_id: `eq.${upload.projectId}`,
        owner_clerk_id: `eq.${upload.ownerId}`,
        select: 'id',
        limit: '1',
      }),
    );
    if (!rows[0]) throw new DocumentRemovedError('PDF was removed before indexing completed.');
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

function countTreeNodes(root: ProjectIndexTreeNode, type?: string): number {
  let count = 0;
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    if (type === undefined || node.type === type) count += 1;
    if (node.children) pending.push(...node.children);
  }
  return count;
}