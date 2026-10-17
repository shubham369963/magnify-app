import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, jest, test } from '@jest/globals';

const renderedPaths = [];
const savedCheckpoints = [];
let checkpoint;
let onCheckpointSaved;
let extractions;
let discoveries;
const defaultListing = [
  '1 0 image 640 480 rgb 3 8 jpeg no 12 0 72 72 30K 5%',
  '2 0 image 120 40 rgb 3 8 jpeg no 13 0 72 72 1K 5%',
  '3 1 image 640 480 rgb 3 8 jpeg no 14 0 72 72 30K 5%',
].join('\n');
let imageListing;
const pages = [1, 2, 3].map((page) => ({
  pageContent: `Evidence on PDF page ${page}.`,
  metadata: { loc: { pageNumber: page }, pdf: { totalPages: 3 } },
}));
const execFile = () => { throw new Error('Expected promisified Poppler invocation'); };
execFile[promisify.custom] = async (command, args) => {
  if (command === 'pdfimages') {
    discoveries += 1;
    return { stdout: imageListing };
  }
  assert.equal(command, 'pdftoppm');
  assert.ok(args.includes('-png'));
  assert.equal(args[args.indexOf('-scale-to') + 1], '1024');
  const path = `${args.at(-1)}.png`;
  renderedPaths.push(path);
  await writeFile(path, args[args.indexOf('-f') + 1]);
  return { stdout: '' };
};
jest.unstable_mockModule('node:child_process', () => ({ execFile }));
jest.unstable_mockModule('@langchain/community/document_loaders/fs/pdf', () => ({
  PDFLoader: class { async load() { extractions += 1; return pages; } },
}));
jest.unstable_mockModule('../../dist/config/settings.js', () => ({
  redisConnection: () => ({ host: 'localhost', port: 6379 }),
  collectionName: 'test-collection',
  createQdrantClient: () => ({}),
  deleteDocumentVectors: async () => {},
  ensureQdrantPayloadIndexes: async () => {},
}));
jest.unstable_mockModule('../../dist/document-service/vector-index-checkpoint.js', () => ({
  loadVectorIndexCheckpoint: async () => checkpoint,
  saveVectorIndexCheckpoint: async (value) => {
    checkpoint = value;
    savedCheckpoints.push(value);
    await onCheckpointSaved?.(value);
  },
  deleteVectorIndexCheckpoint: async () => { checkpoint = undefined; },
}));
const { PdfService } = await import('../../dist/document-service/pdf.service.js');

const document = {
  id: 'document-1',
  project_id: 'project-1',
  owner_clerk_id: 'owner-1',
  storage_path: 'owner-1/project-1/document.pdf',
  file_name: 'source.pdf',
};
const upload = { documentId: document.id, projectId: document.project_id, ownerId: document.owner_clerk_id };
const keys = ['PDF_IMAGE_CONCURRENCY', 'PDF_RENDER_CONCURRENCY', 'PDF_WORKER_CONCURRENCY'];
let previous;
beforeEach(() => {
  renderedPaths.length = 0;
  savedCheckpoints.length = 0;
  checkpoint = undefined;
  onCheckpointSaved = undefined;
  extractions = 0;
  discoveries = 0;
  imageListing = defaultListing;
  previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { PDF_IMAGE_CONCURRENCY: '4', PDF_RENDER_CONCURRENCY: '2', PDF_WORKER_CONCURRENCY: '4' });
});
afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function createService(sourceDocument = document) {
  const updates = [];
  const writes = [];
  const rpcCalls = [];
  const embeddingRequests = [];
  const finishedCaptions = [];
  const downloads = [];
  const deletedObjects = [];
  const service = new PdfService({
    select: async (table) => {
      if (table === 'project_index_trees') return [{ generation: 1, tree: null }];
      if (table === 'projects') return [{ id: document.project_id, name: 'Project' }];
      return [sourceDocument];
    },
    update: async (...args) => updates.push(args),
    downloadObject: async (path) => {
      downloads.push(path);
      return Buffer.from('mock PDF loaded by the test PDFLoader');
    },
    rpc: async (...args) => rpcCalls.push(args),
    deleteObject: async (path) => deletedObjects.push(path),
  });
  service.logger = { log() {}, warn() {}, error() {} };
  service.getVectorStore = async () => ({
    addVectors: async (vectors, docs, options) => writes.push({ vectors, docs, options }),
  });
  service.getEmbeddings = () => ({
    embedDocuments: async (texts, options) => {
      if (options.checkpoint) return options.checkpoint.vectors;
      embeddingRequests.push(texts);
      const vectors = texts.map((_, index) => [index]);
      await options.saveCheckpoint({ model: 'test-model', dimensions: 1, inputHash: 'test-hash', vectors });
      return vectors;
    },
  });
  service.ensurePayloadIndexes = async () => {};
  service.captionImage = async (image) => {
    const pageNumber = Number(String(image));
    const path = renderedPaths.find((path) => path.endsWith(`page-${pageNumber}.png`));
    await assert.rejects(access(path), { code: 'ENOENT' });
    await new Promise((resolve) => setTimeout(resolve, pageNumber === 1 ? 20 : 1));
    finishedCaptions.push(pageNumber);
    return `Caption for page ${pageNumber}`;
  };
  return { service, updates, writes, rpcCalls, finishedCaptions, embeddingRequests, downloads, deletedObjects };
}

async function assertTemporaryDirectoriesRemoved() {
  assert.equal(renderedPaths.length, 2);
  for (const path of renderedPaths) {
    await assert.rejects(access(dirname(path)), { code: 'ENOENT' });
  }
}

test('one ingestion extracts and captions once and shares the results with both indexes', async () => {
  const { service, updates, writes, finishedCaptions, rpcCalls } = createService();
  const progress = [];
  await service.process(upload, async (value) => { progress.push(value); });
  assert.deepEqual(finishedCaptions, [3, 1]);
  assert.equal(writes.length, 1);
  const captions = writes[0].docs.filter((doc) => doc.metadata.content_type === 'image_caption');
  assert.deepEqual(captions.map((doc) => doc.metadata.page_number), [1, 3]);
  for (const caption of captions) {
    assert.equal(caption.metadata.document_id, document.id);
    assert.equal(caption.metadata.project_id, document.project_id);
    assert.equal(caption.metadata.owner_clerk_id, document.owner_clerk_id);
    assert.equal(caption.metadata.source, document.file_name);
    assert.equal(caption.metadata.loc.pageNumber, caption.metadata.page_number);
    assert.equal(caption.metadata.chunk_index, 0);
  }
  assert.equal(writes[0].options.ids.length, writes[0].docs.length);
  assert.equal(new Set(writes[0].options.ids).size, writes[0].docs.length);
  assert.deepEqual(savedCheckpoints[0].documents.map((doc) => doc.pageContent), writes[0].docs.map((doc) => doc.pageContent));
  assert.deepEqual(progress.map((value) => value.percentage), [5, 20, 37, 55, 60, 65, 90, 100]);
  assert.equal(extractions, 1);
  assert.equal(discoveries, 1);
  const tree = rpcCalls.find(([name]) => name === 'complete_document_indexing')[1].p_document_node;
  const evidence = collectEvidence(tree);
  assert.deepEqual(evidence.filter((node) => node.content_type === 'image_caption').map((node) => node.content_reference),
    captions.map((caption) => caption.pageContent));
  assert.deepEqual(savedCheckpoints[0].documentNode, tree);
  assert.ok(updates.every(([, , value]) => value.processing_status !== 'completed'));
  assert.equal(checkpoint, undefined);
  await assertTemporaryDirectoriesRemoved();
});

test('Index Tree ingestion retains ordered image evidence and unique passage IDs', async () => {
  const { service, rpcCalls, finishedCaptions } = createService();
  await service.processProjectTree({ ...upload, generation: 1 });
  assert.deepEqual(finishedCaptions, [3, 1]);
  const savedTree = rpcCalls.find(([name]) => name === 'save_project_index_tree')[1].p_tree;
  const evidence = [];
  const visit = (node) => {
    if (node.type === 'passage') evidence.push(node);
    node.children?.forEach(visit);
  };
  visit(savedTree);
  const captions = evidence.filter((node) => node.content_type === 'image_caption').sort((a, b) => a.source_order - b.source_order);
  assert.deepEqual(captions.map((node) => node.page), [1, 3]);
  assert.deepEqual(captions.map((node) => node.content_reference), ['Caption for page 1', 'Caption for page 3']);
  assert.ok(captions.every((node) => node.document_id === document.id && node.source === document.file_name));
  assert.equal(new Set(evidence.map((node) => node.id)).size, evidence.length);
  assert.ok(!rpcCalls.some(([name]) => name === 'complete_document_indexing'));
  await assertTemporaryDirectoriesRemoved();
});

test('a second PDF processes only its own source and embeds only its own chunks and captions', async () => {
  const first = createService();
  await first.service.process(upload);
  const secondDocument = {
    ...document,
    id: 'document-2',
    storage_path: 'owner-1/project-1/document-2.pdf',
    file_name: 'second.pdf',
  };
  const second = createService(secondDocument);
  await second.service.process({ ...upload, documentId: secondDocument.id });
  assert.equal(extractions, 2);
  assert.equal(discoveries, 2);
  assert.deepEqual(first.downloads, [document.storage_path]);
  assert.deepEqual(second.downloads, [secondDocument.storage_path]);
  assert.equal(first.embeddingRequests.length, 1);
  assert.equal(second.embeddingRequests.length, 1);
  assert.equal(first.writes.length, 1);
  assert.equal(second.writes.length, 1);
  assert.ok(second.writes[0].docs.every((doc) =>
    doc.metadata.document_id === secondDocument.id && doc.metadata.source === secondDocument.file_name));
  const mergedNode = second.rpcCalls.find(([name]) => name === 'complete_document_indexing')[1].p_document_node;
  assert.equal(mergedNode.document_id, secondDocument.id);
  assert.ok(!first.writes[0].options.ids.some((id) => second.writes[0].options.ids.includes(id)));
});

test('failed ingestion waits for pending captions before removing temporary files', async () => {
  const { service, writes, rpcCalls } = createService();
  let secondStarted;
  const pendingSecond = new Promise((resolve) => { secondStarted = resolve; });
  let releaseSecond;
  const release = new Promise((resolve) => { releaseSecond = resolve; });
  let failureStarted;
  const pendingFailure = new Promise((resolve) => { failureStarted = resolve; });
  const failure = new Error('Vision unavailable');
  service.captionImage = async (image) => {
    if (String(image) === '1') {
      await pendingSecond;
      failureStarted();
      throw failure;
    }
    secondStarted();
    await release;
    await access(dirname(renderedPaths[0]));
    return 'Caption for page 3';
  };
  let settled = false;
  const result = service.process(upload).then(
    () => { settled = true; return null; },
    (error) => { settled = true; return error; },
  );
  await pendingFailure;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  await access(dirname(renderedPaths[0]));
  releaseSecond();
  assert.equal(await result, failure);
  assert.deepEqual(writes, []);
  assert.deepEqual(savedCheckpoints, []);
  assert.ok(rpcCalls.some(([name]) => name === 'fail_document_indexing'));
  assert.ok(!rpcCalls.some(([name]) => name === 'complete_document_indexing'));
  await assertTemporaryDirectoriesRemoved();
});

function collectEvidence(node) {
  return node.type === 'passage' ? [node] : (node.children ?? []).flatMap(collectEvidence);
}

for (const strategy of ['vector', 'index_tree']) {
  test(`text-only upload builds both indexes without rendering, regardless of ${strategy} retrieval selection`, async () => {
    imageListing = '';
    const { service, writes, rpcCalls, finishedCaptions } = createService();
    await service.process({ ...upload, strategy });
    assert.equal(extractions, 1);
    assert.equal(discoveries, 1);
    assert.equal(writes.length, 1);
    assert.deepEqual(renderedPaths, []);
    assert.deepEqual(finishedCaptions, []);
    const tree = rpcCalls.find(([name]) => name === 'complete_document_indexing')[1].p_document_node;
    assert.equal(collectEvidence(tree).length, 3);
    assert.equal(checkpoint, undefined);
  });
}

test('upload stays incomplete until tree persistence succeeds, and a retry reuses shared preparation and embeddings', async () => {
  const { service, writes, rpcCalls, finishedCaptions, updates, embeddingRequests } = createService();
  const rpc = service.supabase.rpc;
  let release;
  const persist = new Promise((resolve) => { release = resolve; });
  let entered;
  const enteredPersistence = new Promise((resolve) => { entered = resolve; });
  service.supabase.rpc = async (...args) => {
    if (args[0] === 'complete_document_indexing') {
      assert.equal(writes.length, 1);
      entered();
      await persist;
      throw new Error('Tree database unavailable');
    }
    return rpc(...args);
  };
  const progress = [];
  let settled = false;
  const result = service.process(upload, async (value) => progress.push(value))
    .then(() => { settled = true; }, (error) => { settled = true; return error; });
  await enteredPersistence;
  assert.equal(settled, false);
  assert.ok(!progress.some((value) => value.percentage === 100));
  assert.ok(updates.every(([, , value]) => value.processing_status !== 'completed'));
  release();
  assert.match((await result).message, /Tree database unavailable/);
  assert.ok(checkpoint?.documentNode);
  assert.ok(checkpoint?.embeddings);
  assert.equal(extractions, 1);
  assert.deepEqual(finishedCaptions, [3, 1]);
  service.supabase.rpc = rpc;
  await service.process(upload);
  assert.equal(extractions, 1);
  assert.equal(discoveries, 1);
  assert.equal(renderedPaths.length, 2);
  assert.equal(writes.length, 2);
  assert.equal(embeddingRequests.length, 1);
  assert.deepEqual(writes[0].vectors, writes[1].vectors);
  assert.deepEqual(writes[0].options.ids, writes[1].options.ids);
  assert.ok(rpcCalls.some(([name]) => name === 'complete_document_indexing'));
  assert.equal(checkpoint, undefined);
});

test('embedding failure never persists a completed tree or reports combined completion', async () => {
  const { service, rpcCalls } = createService();
  service.getEmbeddings = () => ({ embedDocuments: async () => { throw new Error('Embedding service unavailable'); } });
  const progress = [];
  await assert.rejects(service.process(upload, async (value) => progress.push(value)), /Embedding service unavailable/);
  assert.ok(!rpcCalls.some(([name]) => name === 'complete_document_indexing'));
  assert.ok(rpcCalls.some(([name]) => name === 'fail_document_indexing'));
  assert.ok(!progress.some((value) => value.stage === 'completed'));
  assert.ok(checkpoint?.documentNode);
});

async function assertQuotaRemoval(run, provider) {
  const { UnrecoverableError } = await import('bullmq');
  const { service, rpcCalls, writes, deletedObjects } = run.created;
  const progress = [];
  await assert.rejects(service.process(upload, async (value) => progress.push(value)), (error) =>
    error.name === 'ProviderQuotaError' && error instanceof UnrecoverableError);
  assert.equal(writes.length, 0);
  assert.ok(!rpcCalls.some(([name]) => name === 'complete_document_indexing' || name === 'fail_document_indexing'));
  assert.deepEqual(rpcCalls.find(([name]) => name === 'discard_document_indexing')[1], {
    p_project_id: document.project_id, p_owner_clerk_id: document.owner_clerk_id, p_document_id: document.id,
  });
  assert.deepEqual(deletedObjects, [document.storage_path]);
  assert.equal(checkpoint, undefined);
  const failure = progress.at(-1);
  assert.equal(failure.stage, 'failed');
  assert.match(failure.error, new RegExp(`${provider} quota exceeded.*The PDF was removed`));
}

test('an embedding quota error stops indexing, removes the PDF, and records the reason for the UI', async () => {
  const created = createService();
  created.service.getEmbeddings = () => ({ embedDocuments: async () => {
    throw new Error('Gemini embedding request failed (429): RESOURCE_EXHAUSTED');
  } });
  await assertQuotaRemoval({ created }, 'AI provider');
});

test('a vision quota error stops further captioning and removes the PDF', async () => {
  imageListing = Array.from({ length: 8 }, (_, index) => `${index + 1} 0 image 640 480 rgb 3 8 jpeg no ${20 + index} 0 72 72 30K 5%`).join('\n');
  Object.assign(process.env, { PDF_IMAGE_CONCURRENCY: '1', PDF_RENDER_CONCURRENCY: '1' });
  const created = createService();
  let captionCalls = 0;
  created.service.captionImage = async () => {
    captionCalls += 1;
    throw Object.assign(new Error('you have reached your usage limit'), { status_code: 429 });
  };
  await assertQuotaRemoval({ created }, 'Image captioning');
  assert.equal(captionCalls, 1);
  assert.equal(created.embeddingRequests.length, 0);
});

test('a Qdrant write failure retains embeddings and retries the write without new embeddings', async () => {
  const { service, writes, embeddingRequests, rpcCalls } = createService();
  const getStore = service.getVectorStore;
  service.getVectorStore = async () => ({
    addVectors: async () => { throw new Error('Qdrant unavailable'); },
  });
  await assert.rejects(service.process(upload), /Qdrant unavailable/);
  assert.ok(checkpoint?.embeddings);
  assert.equal(embeddingRequests.length, 1);
  assert.ok(!rpcCalls.some(([name]) => name === 'complete_document_indexing'));
  service.getVectorStore = getStore;
  await service.process(upload);
  assert.equal(embeddingRequests.length, 1);
  assert.equal(writes.length, 1);
  assert.equal(extractions, 1);
  assert.equal(checkpoint, undefined);
});

test('a fresh worker resumes only missing Gemini batches after a whole indexing job retry', async () => {
  const { GeminiEmbeddings } = await import('../../dist/config/gemini-embeddings.js');
  const settings = {
    GEMINI_EMBEDDING_MODEL: 'gemini-embedding-2', GEMINI_EMBEDDING_DIMENSIONS: '1',
    GEMINI_EMBEDDING_BATCH_SIZE: '2', GEMINI_EMBEDDING_BATCH_CONCURRENCY: '1', GEMINI_EMBEDDING_MAX_ATTEMPTS: '1',
    GEMINI_EMBEDDING_REQUEST_TIMEOUT_MS: '60000', GEMINI_EMBEDDING_RETRY_DELAY_MS: '250',
    GEMINI_EMBEDDING_MAX_RETRY_AFTER_MS: '120000',
  };
  const previousSettings = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, settings);
  const requests = [];
  let quotaExceeded = true;
  globalThis.fetch = async (_url, options) => {
    const batch = JSON.parse(options.body).requests.map(({ content }) => content.parts[0].text);
    requests.push(batch);
    if (requests.length === 2 && quotaExceeded) return new Response('Service unavailable', { status: 503 });
    return Response.json({ embeddings: batch.map(() => ({ values: [1] })) });
  };
  try {
    const firstWorker = createService();
    firstWorker.service.getEmbeddings = () => new GeminiEmbeddings('test-key');
    await assert.rejects(firstWorker.service.process(upload), /503/);
    assert.equal(firstWorker.writes.length, 0);
    assert.equal(checkpoint.embeddings.vectors.filter((vector) => vector !== null).length, 2);
    assert.ok(!firstWorker.rpcCalls.some(([name]) => name === 'complete_document_indexing'));

    quotaExceeded = false;
    const nextWorker = createService();
    nextWorker.service.getEmbeddings = () => new GeminiEmbeddings('test-key');
    await nextWorker.service.process(upload);
    assert.equal(extractions, 1);
    assert.equal(discoveries, 1);
    assert.equal(requests.length, 4);
    assert.deepEqual(requests[2], requests[1]);
    assert.equal(requests[3].length, 1);
    assert.ok(requests.slice(2).flat().every((text) => !requests[0].includes(text)));
    assert.equal(nextWorker.writes.length, 1);
    assert.equal(nextWorker.writes[0].vectors.length, 5);
    assert.ok(nextWorker.rpcCalls.some(([name]) => name === 'complete_document_indexing'));
    assert.equal(checkpoint, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousSettings)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('deletion during embedding checkpoint persistence removes the checkpoint and never writes vectors', async () => {
  const { service, writes } = createService();
  let deleted = false;
  const select = service.supabase.select;
  service.supabase.select = async (table, query) => table === 'documents' && deleted ? [] : select(table, query);
  onCheckpointSaved = (value) => { if (value.embeddings) deleted = true; };
  await assert.rejects(service.process(upload), /removed before indexing completed/);
  assert.equal(writes.length, 0);
  assert.equal(checkpoint, undefined);
});

test('deleting the PDF during captioning cancels indexing without retries or persisted output', async () => {
  const { UnrecoverableError } = await import('bullmq');
  const { service, writes, rpcCalls } = createService();
  let deleted = false;
  const select = service.supabase.select;
  service.supabase.select = async (table, query) => table === 'documents' && deleted ? [] : select(table, query);
  const caption = service.captionImage;
  service.captionImage = async (image) => {
    deleted = true;
    return caption(image);
  };
  await assert.rejects(service.process(upload), (error) =>
    error instanceof UnrecoverableError && /removed before indexing completed/.test(error.message));
  assert.equal(writes.length, 0);
  assert.ok(!rpcCalls.some(([name]) => name === 'complete_document_indexing'));
  assert.ok(rpcCalls.some(([name]) => name === 'fail_document_indexing'));
  assert.equal(checkpoint, undefined);
  await assertTemporaryDirectoriesRemoved();
});

test('a job for an already deleted PDF fails permanently before downloading it', async () => {
  const { UnrecoverableError } = await import('bullmq');
  const { service } = createService();
  service.supabase.select = async () => [];
  service.supabase.downloadObject = async () => { throw new Error('Should not download a deleted PDF'); };
  await assert.rejects(service.process(upload), (error) =>
    error instanceof UnrecoverableError && /removed before indexing started/.test(error.message));
  assert.equal(extractions, 0);
});
