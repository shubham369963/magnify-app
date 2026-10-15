import { Inject, Injectable, Logger } from '@nestjs/common';
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
import { SupabaseService } from '../database/supabase.service.js';
import type { ProjectDocument } from '../entities/project-document.entity.js';
import { DocumentProcessingStatus } from '../enums/document-processing-status.enum.js';
import { imagePagesFromListing, splitPageText, stableVectorPointId } from './pdf-chunking.utils.js';
import { createIndexSectionId, createSourcePassages, groupSourcePassagesBySection, linkAdjacentTreeEvidence, normalizeStructuredPageText, orderSourcePassages, selectTreeDocuments, summarizeSourcePassages, validateProjectIndexTree, type ProjectIndexTreeNode } from './index-tree.utils.js';
import { metrics } from '../observability/metrics.js';
import { withOperationLog } from '../shared-utils/operation-logger.js';
import { deleteVectorIndexCheckpoint, loadVectorIndexCheckpoint, saveVectorIndexCheckpoint } from './vector-index-checkpoint.js';

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
  stage: 'loading' | 'building_tree' | 'embedding' | 'storing' | 'completed';
  percentage: number;
}

const execFileAsync = promisify(execFile);

@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);
  private readonly qdrantClient = createQdrantClient();
  private vectorStorePromise?: Promise<QdrantVectorStore>;
  private payloadIndexesPromise?: Promise<void>;
  private get visionModel() {
    return createOllamaCloudVisionModel();
  }

  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService) {}

  async process(upload: UploadJobData, reportProgress?: (progress: IndexingProgress) => Promise<void>) {
    return withOperationLog(this.logger, 'document.processing', {
      documentId: upload.documentId,
      projectId: upload.projectId,
      strategy: upload.strategy ?? 'vector',
    }, () => this.processUpload(upload, reportProgress));
  }

  private async processUpload(upload: UploadJobData, reportProgress?: (progress: IndexingProgress) => Promise<void>) {
    if (upload.strategy === 'index_tree') {
      const generation = upload.generation ?? await this.supabase.rpc<number>('request_project_index_tree', {
        p_project_id: upload.projectId,
        p_owner_clerk_id: upload.ownerId,
      });
      await this.processProjectTree({ ...upload, generation }, reportProgress);
      return;
    }

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
    if (!document) throw new Error('Document metadata is missing for the queued upload.');

    const ingestion = metrics.startIngestion('vector');
    metrics.addIngestionUnits('vector', 'documents');
    let tempDirectory: string | undefined;
    try {
      await this.setStatus(upload, DocumentProcessingStatus.Processing, null);
      let docs: Document[];
      const checkpointIdentity = {
        documentId: document.id,
        projectId: document.project_id,
        ownerId: document.owner_clerk_id,
        storagePath: document.storage_path,
      };
      const checkpoint = await loadVectorIndexCheckpoint(checkpointIdentity);
      if (checkpoint) {
        docs = checkpoint.documents.map((item) => new Document(item));
        this.logger.log(JSON.stringify({
          event: 'document.processing.resume',
          documentId: document.id,
          projectId: document.project_id,
          stage: 'vector_indexing',
          passageCount: docs.length,
        }));
        await reportProgress?.({ stage: 'storing', percentage: 75 });
      } else {
        const tempDirectoryPath = await mkdtemp(join(tmpdir(), 'magnify-pdf-'));
        tempDirectory = tempDirectoryPath;
        const pdfPath = join(tempDirectoryPath, 'document.pdf');
        await reportProgress?.({ stage: 'loading', percentage: 5 });
        const file = await metrics.trackStage('vector', 'storage_download', () => this.supabase.downloadObject(document.storage_path));
        await writeFile(pdfPath, file, { flag: 'wx' });
        const loader = new PDFLoader(pdfPath);
        const pages = await metrics.trackStage('vector', 'pdf_text_extraction', () => loader.load());
        metrics.addIngestionUnits('vector', 'pages', pages.length);
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
        const { stdout: imageListing } = await metrics.trackStage('vector', 'image_discovery', () =>
          execFileAsync('pdfimages', ['-list', pdfPath], { maxBuffer: 10 * 1024 * 1024 }));
        const imagePages = imagePagesFromListing(imageListing);
        await reportProgress?.({ stage: 'embedding', percentage: 25 });
        await metrics.trackStage('vector', 'image_captioning', async () => {
          for (const [index, pageNumber] of imagePages.entries()) {
            const imagePrefix = join(tempDirectoryPath, `page-${pageNumber}`);
            await metrics.trackStage('vector', 'image_rendering', () => execFileAsync('pdftoppm', [
              '-f', String(pageNumber), '-l', String(pageNumber), '-singlefile',
              '-scale-to', '1024', '-png', pdfPath, imagePrefix,
            ]));
            const image = await readFile(`${imagePrefix}.png`);
            const caption = await metrics.trackModelCall('vector', 'image_caption', () => this.captionImage(image));
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
              metrics.addIngestionUnits('vector', 'image_captions');
            }
            await reportProgress?.({
              stage: 'embedding',
              percentage: 25 + Math.floor(((index + 1) / imagePages.length) * 40),
            });
          }
        });
        await saveVectorIndexCheckpoint({
          ...checkpointIdentity,
          documents: docs.map(({ pageContent, metadata }) => ({ pageContent, metadata })),
        });
      }
      metrics.addIngestionUnits('vector', 'passages', docs.length);
      const vectorStore = await metrics.trackStage('vector', 'vector_store_setup', async () => {
        const store = await this.getVectorStore();
        await this.ensurePayloadIndexes();
        return store;
      });
      await this.assertDocumentExists(upload);
      await deleteDocumentVectors(document.id);
      await reportProgress?.({ stage: 'storing', percentage: 75 });
      if (docs.length) {
        const pointIds = docs.map((doc, index) => stableVectorPointId(
          document.id,
          Number(doc.metadata.page_number) || index + 1,
          String(doc.metadata.content_type ?? 'text'),
          doc.pageContent,
        ));
        try {
          await metrics.trackDependency('qdrant', 'upsert', () => vectorStore.addDocuments(docs, { ids: pointIds }));
          metrics.observeVectorOperation('vector_write', 'success');
        } catch (error) {
          metrics.observeVectorOperation('vector_write', 'error');
          throw error;
        }
      }
      await this.assertDocumentExists(upload);
      await this.setStatus(upload, DocumentProcessingStatus.Completed, null);
      await reportProgress?.({ stage: 'completed', percentage: 100 });
      await this.logCleanupFailure('remove completed vector indexing checkpoint', () =>
        deleteVectorIndexCheckpoint(document.id));
      ingestion.setOutcome('success');
    } catch (error) {
      await this.logCleanupFailure('delete partial document vectors', () => deleteDocumentVectors(document.id));
      await this.logCleanupFailure('mark document as failed', () =>
        this.setStatus(upload, DocumentProcessingStatus.Failed, 'PDF processing failed. Please retry the upload.'));
      throw error;
    } finally {
      try {
        if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
      } finally {
        ingestion.finish();
      }
    }
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
    if (documentsToProcess.length) {
      await this.supabase.update('documents', new URLSearchParams({
        project_id: `eq.${upload.projectId}`,
        owner_clerk_id: `eq.${upload.ownerId}`,
        id: `in.(${documentsToProcess.map((document) => document.id).join(',')})`,
      }), { processing_status: DocumentProcessingStatus.Processing, processing_error: null, updated_at: new Date().toISOString() });
    }
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
        const passages = createSourcePassages(pages);
        const { stdout: imageListing } = await metrics.trackStage('index_tree', 'image_discovery', () =>
          execFileAsync('pdfimages', ['-list', pdfPath], { maxBuffer: 10 * 1024 * 1024 }));
        const imagePages = imagePagesFromListing(imageListing);
        await metrics.trackStage('index_tree', 'image_captioning', async () => {
          for (const pageNumber of imagePages) {
            const imagePrefix = join(directory, `tree-page-${pageNumber}`);
            await metrics.trackStage('index_tree', 'image_rendering', () => execFileAsync('pdftoppm', [
              '-f', String(pageNumber), '-l', String(pageNumber), '-singlefile',
              '-scale-to', '1024', '-png', pdfPath, imagePrefix,
            ]));
            const image = await readFile(`${imagePrefix}.png`);
            const caption = await metrics.trackModelCall('index_tree', 'image_caption', () => this.captionImage(image));
            if (caption) {
              passages.push({
                id: `P${String(passages.length + 1).padStart(6, '0')}`,
                sourceOrder: passages.length + 1,
                page: pageNumber,
                content: caption,
                normalizedContent: normalizeStructuredPageText(caption) ?? caption,
                contentType: 'image_caption',
              });
              metrics.addIngestionUnits('index_tree', 'image_captions');
            }
          }
        });
        orderSourcePassages(passages, document.id);
        if (!passages.length) {
          throw new Error(`${document.file_name} has no extractable text or image captions.`);
        }
        metrics.addIngestionUnits('index_tree', 'passages', passages.length);

        const passagesById = new Map(passages.map((passage) => [passage.id, passage]));
        const collectPassageIds = (section: ReturnType<typeof groupSourcePassagesBySection>[number]): string[] => [
          ...section.passageIds,
          ...(section.children ?? []).flatMap(collectPassageIds),
        ];
        let sectionIndex = 0;
        const createSectionNode = (
          section: ReturnType<typeof groupSourcePassagesBySection>[number],
          depth: number,
        ): ProjectIndexTreeNode => {
          const sectionPassages = collectPassageIds(section).flatMap((id) => {
            const passage = passagesById.get(id);
            return passage ? [passage] : [];
          }).sort((left, right) => left.sourceOrder - right.sourceOrder);
          const sectionPages = sectionPassages.map((passage) => passage.page);
          return {
            id: createIndexSectionId(document.id, ++sectionIndex),
            type: depth === 0 ? 'section' : 'subsection',
            title: section.title,
            summary: summarizeSourcePassages(sectionPassages),
            start_page: Math.min(...sectionPages),
            end_page: Math.max(...sectionPages),
            children: [
              ...(section.children ?? []).map((child) => createSectionNode(child, depth + 1)),
              ...section.passageIds.flatMap((id) => {
                const passage = passagesById.get(id);
                return passage ? [{
              id: `evidence-${document.id}-${passage.id}`,
              type: 'passage',
              title: `Page ${passage.page}`,
              document_id: document.id,
              source: document.file_name,
              page: passage.page,
              source_order: passage.sourceOrder,
              continues_from_previous: passage.continuesFromPrevious,
              continues_to_next: passage.continuesToNext,
              content_type: passage.contentType ?? 'text',
              content_reference: passage.content,
              normalized_content: passage.normalizedContent ?? passage.content,
                }] : [];
              }),
            ],
          };
        };
        const sectionNodes = metrics.trackStageSync('index_tree', 'tree_generation', () =>
          groupSourcePassagesBySection(passages).map((section) => createSectionNode(section, 0)));
        await sendProgress({
          stage: 'building_tree',
          percentage: 20 + Math.floor(((documentIndex + 1) / documentsToProcess.length) * 65),
        });
        documentNodes.push({
          id: `document-${document.id}`,
          type: 'document',
          title: document.file_name,
          summary: `${pages.length} pages of extracted text and ${passages.filter((passage) => passage.contentType === 'image_caption').length} image captions`,
          document_id: document.id,
          source: document.file_name,
          start_page: Math.min(...passages.map((passage) => passage.page)),
          end_page: Math.max(...passages.map((passage) => passage.page)),
          children: sectionNodes,
        });
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
      await this.supabase.update('documents', new URLSearchParams({
        project_id: `eq.${upload.projectId}`,
        owner_clerk_id: `eq.${upload.ownerId}`,
      }), { processing_status: DocumentProcessingStatus.Completed, processing_error: null, updated_at: new Date().toISOString() });
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
        if (processingDocumentIds.size) {
          await this.logCleanupFailure('mark project documents as failed', () => this.supabase.update('documents', new URLSearchParams({
            project_id: `eq.${upload.projectId}`,
            owner_clerk_id: `eq.${upload.ownerId}`,
            id: `in.(${[...processingDocumentIds].join(',')})`,
          }), { processing_status: DocumentProcessingStatus.Failed, processing_error: message.slice(0, 1000), updated_at: new Date().toISOString() }));
        }
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
    await this.supabase.update('documents', new URLSearchParams({
      project_id: `eq.${upload.projectId}`,
      owner_clerk_id: `eq.${upload.ownerId}`,
    }), {
      processing_status: DocumentProcessingStatus.Failed,
      processing_error: message.slice(0, 1000),
      updated_at: new Date().toISOString(),
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
          new GeminiEmbeddings(),
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
    if (!rows[0]) throw new Error('PDF was removed before indexing completed.');
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

function countTreeNodes(root: ProjectIndexTreeNode): number {
  let count = 0;
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    count += 1;
    if (node.children) pending.push(...node.children);
  }
  return count;
}