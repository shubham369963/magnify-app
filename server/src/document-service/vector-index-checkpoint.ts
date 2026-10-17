import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateProjectIndexTree, type ProjectIndexTreeNode } from './index-tree.utils.js';
import type { GeminiEmbeddingCheckpoint } from '../config/gemini-embeddings.js';

export interface VectorIndexCheckpointIdentity {
  documentId: string;
  projectId: string;
  ownerId: string;
  storagePath: string;
}

export interface VectorIndexCheckpoint extends VectorIndexCheckpointIdentity {
  documents: Array<{ pageContent: string; metadata: Record<string, unknown> }>;
  documentNode?: ProjectIndexTreeNode;
  embeddings?: GeminiEmbeddingCheckpoint;
}

function checkpointPath(documentId: string): string {
  const directory = process.env.PDF_INDEX_CHECKPOINT_DIR
    || join(process.cwd(), 'uploads', '.vector-index-checkpoints');
  const key = createHash('sha256').update(documentId).digest('hex');
  return join(directory, `${key}.json`);
}

export async function loadVectorIndexCheckpoint(
  identity: VectorIndexCheckpointIdentity,
): Promise<VectorIndexCheckpoint | undefined> {
  const path = checkpointPath(identity.documentId);
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let reason = 'Checkpoint source identity or prepared documents did not match.';
  try {
    const checkpoint = JSON.parse(contents) as VectorIndexCheckpoint;
    const matchesIdentity = checkpoint.documentId === identity.documentId
      && checkpoint.projectId === identity.projectId
      && checkpoint.ownerId === identity.ownerId
      && checkpoint.storagePath === identity.storagePath;
    const hasValidDocuments = Array.isArray(checkpoint.documents)
      && checkpoint.documents.every((document) => typeof document.pageContent === 'string'
        && typeof document.metadata === 'object'
        && document.metadata !== null
        && !Array.isArray(document.metadata));
    if (matchesIdentity && hasValidDocuments) {
      if (checkpoint.documentNode !== undefined) {
        validateProjectIndexTree({
          id: 'checkpoint-root',
          type: 'root',
          title: 'Prepared document',
          source_document_ids: [identity.documentId],
          children: [checkpoint.documentNode],
        }, [identity.documentId]);
      }
      return checkpoint;
    }
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  console.warn(JSON.stringify({ event: 'document.checkpoint.discarded', documentId: identity.documentId, reason }));
  await rm(path, { force: true });
  return undefined;
}

export async function saveVectorIndexCheckpoint(checkpoint: VectorIndexCheckpoint): Promise<void> {
  const path = checkpointPath(checkpoint.documentId);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(checkpoint), { flag: 'wx' });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function deleteVectorIndexCheckpoint(documentId: string): Promise<void> {
  await rm(checkpointPath(documentId), { force: true });
}