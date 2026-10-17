import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from '@jest/globals';
import {
  deleteVectorIndexCheckpoint,
  loadVectorIndexCheckpoint,
  saveVectorIndexCheckpoint,
} from '../../dist/document-service/vector-index-checkpoint.js';
import { createDocumentTreeNode } from '../../dist/document-service/index-tree.utils.js';

test('vector checkpoints survive retries and are scoped to the source document', async () => {
  const previousDirectory = process.env.PDF_INDEX_CHECKPOINT_DIR;
  const directory = await mkdtemp(join(tmpdir(), 'vector-checkpoint-test-'));
  process.env.PDF_INDEX_CHECKPOINT_DIR = directory;
  const identity = {
    documentId: 'document-1',
    projectId: 'project-1',
    ownerId: 'owner-1',
    storagePath: 'owner-1/project-1/document-1/file.pdf',
  };
  const checkpoint = {
    ...identity,
    documents: [{ pageContent: 'Page text', metadata: { page_number: 1 } }],
  };
  try {
    await saveVectorIndexCheckpoint(checkpoint);
    assert.deepEqual(await loadVectorIndexCheckpoint(identity), checkpoint);
    assert.equal(await loadVectorIndexCheckpoint({ ...identity, storagePath: 'changed.pdf' }), undefined);
    assert.equal(await loadVectorIndexCheckpoint(identity), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (previousDirectory === undefined) delete process.env.PDF_INDEX_CHECKPOINT_DIR;
    else process.env.PDF_INDEX_CHECKPOINT_DIR = previousDirectory;
  }
});

test('deleting a vector checkpoint is idempotent', async () => {
  const previousDirectory = process.env.PDF_INDEX_CHECKPOINT_DIR;
  const directory = await mkdtemp(join(tmpdir(), 'vector-checkpoint-test-'));
  process.env.PDF_INDEX_CHECKPOINT_DIR = directory;
  const identity = {
    documentId: 'document-2',
    projectId: 'project-1',
    ownerId: 'owner-1',
    storagePath: 'owner-1/project-1/document-2/file.pdf',
  };
  try {
    await saveVectorIndexCheckpoint({ ...identity, documents: [] });
    await deleteVectorIndexCheckpoint(identity.documentId);
    await deleteVectorIndexCheckpoint(identity.documentId);
    assert.equal(await loadVectorIndexCheckpoint(identity), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (previousDirectory === undefined) delete process.env.PDF_INDEX_CHECKPOINT_DIR;
    else process.env.PDF_INDEX_CHECKPOINT_DIR = previousDirectory;
  }
});

test('shared checkpoints preserve the prepared tree and discard corrupted or mismatched tree nodes', async () => {
  const previousDirectory = process.env.PDF_INDEX_CHECKPOINT_DIR;
  const directory = await mkdtemp(join(tmpdir(), 'shared-checkpoint-test-'));
  process.env.PDF_INDEX_CHECKPOINT_DIR = directory;
  const identity = { documentId: 'document-1', projectId: 'project-1', ownerId: 'owner-1', storagePath: 'source.pdf' };
  const documentNode = createDocumentTreeNode(
    { id: identity.documentId, file_name: 'source.pdf' }, [{ pageNumber: 1, text: 'Prepared source evidence.' }], [],
  );
  const checkpoint = { ...identity, documents: [{ pageContent: 'Prepared source evidence.', metadata: {} }], documentNode };
  try {
    await saveVectorIndexCheckpoint(checkpoint);
    assert.deepEqual(await loadVectorIndexCheckpoint(identity), JSON.parse(JSON.stringify(checkpoint)));
    await saveVectorIndexCheckpoint({ ...checkpoint, documentNode: { ...documentNode, document_id: 'other-document' } });
    assert.equal(await loadVectorIndexCheckpoint(identity), undefined);
    assert.equal(await loadVectorIndexCheckpoint(identity), undefined);
    await saveVectorIndexCheckpoint({ ...checkpoint, documentNode: { ...documentNode, children: [] } });
    assert.equal(await loadVectorIndexCheckpoint(identity), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (previousDirectory === undefined) delete process.env.PDF_INDEX_CHECKPOINT_DIR;
    else process.env.PDF_INDEX_CHECKPOINT_DIR = previousDirectory;
  }
});

test('checkpoint read failures are surfaced instead of silently discarding persisted embeddings', async () => {
  const previousDirectory = process.env.PDF_INDEX_CHECKPOINT_DIR;
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-read-failure-test-'));
  process.env.PDF_INDEX_CHECKPOINT_DIR = directory;
  const identity = { documentId: 'document-1', projectId: 'project-1', ownerId: 'owner-1', storagePath: 'source.pdf' };
  const path = join(directory, `${createHash('sha256').update(identity.documentId).digest('hex')}.json`);
  try {
    await mkdir(path);
    await assert.rejects(loadVectorIndexCheckpoint(identity), { code: 'EISDIR' });
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (previousDirectory === undefined) delete process.env.PDF_INDEX_CHECKPOINT_DIR;
    else process.env.PDF_INDEX_CHECKPOINT_DIR = previousDirectory;
  }
});