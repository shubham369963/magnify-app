import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { UploadService } from '../../dist/document-service/upload.service.js';

for (const rag_strategy of ['vector', 'index_tree']) {
  test(`upload enqueues exactly one combined job when retrieval strategy is ${rag_strategy}`, async () => {
    const jobs = [];
    const calls = [];
    const service = Object.create(UploadService.prototype);
    service.projects = { get: async () => ({ rag_strategy }) };
    service.supabase = {
      uploadObject: async (...args) => calls.push(['storage', ...args]),
      insert: async (...args) => calls.push(['insert', ...args]),
      rpc: async (...args) => { calls.push(['rpc', ...args]); return 1; },
    };
    service.queue = {
      add: async (...args) => {
        jobs.push(args);
        return { id: args[2].jobId };
      },
    };
    const buffer = Buffer.from('%PDF-1.7 mock source');
    const result = await service.performUpload({ buffer, size: buffer.length, originalname: 'source.pdf' }, 'owner', 'project');
    assert.equal(jobs.length, 1);
    const [name, data, options] = jobs[0];
    assert.equal(name, 'document-index');
    assert.equal(options.jobId, result.documentId);
    assert.equal(options.attempts, 3);
    assert.equal(result.jobId, result.documentId);
    assert.equal(data.documentId, result.documentId);
    assert.equal(data.strategy, undefined);
    assert.equal(calls.filter(([operation]) => operation === 'storage').length, 1);
    assert.equal(calls.filter(([operation]) => operation === 'insert').length, 1);
    assert.equal(calls.filter(([operation]) => operation === 'rpc').length, 1);
  });
}

test('enqueue failure cleans up the upload and records a project indexing failure', async () => {
  const calls = [];
  const service = Object.create(UploadService.prototype);
  service.logger = { warn() {} };
  service.projects = { get: async () => ({}) };
  service.supabase = {
    uploadObject: async () => {},
    insert: async () => {},
    rpc: async (name) => { calls.push(name); return 1; },
    delete: async () => calls.push('delete-row'),
    deleteObject: async () => calls.push('delete-pdf'),
  };
  service.queue = { add: async () => { throw new Error('Queue unavailable'); } };
  const buffer = Buffer.from('%PDF-1.7 mock');
  await assert.rejects(service.performUpload({ buffer, size: buffer.length, originalname: 'source.pdf' }, 'owner', 'project'), /Queue unavailable/);
  assert.deepEqual(calls, ['request_project_index_tree', 'fail_project_index_tree', 'delete-row', 'delete-pdf']);
});

test('upload status requires both the combined job and persisted indexing to complete', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const service = Object.create(UploadService.prototype);
  let state = 'active';
  let documentStatus = 'processing';
  service.queue = { getJob: async () => ({ data: { ownerId: 'owner' }, getState: async () => state, progress: 90 }) };
  service.supabase = { select: async () => [{ processing_status: documentStatus }] };
  assert.equal((await service.getStatus(id, 'owner')).status, 'processing');
  state = 'completed';
  assert.equal((await service.getStatus(id, 'owner')).status, 'processing');
  documentStatus = 'completed';
  assert.equal((await service.getStatus(id, 'owner')).status, 'completed');
  documentStatus = 'failed';
  assert.equal((await service.getStatus(id, 'owner')).status, 'failed');
  state = 'delayed';
  assert.equal((await service.getStatus(id, 'owner')).status, 'queued');
  service.queue.getJob = async () => undefined;
  documentStatus = 'completed';
  assert.equal((await service.getStatus(id, 'owner')).status, 'completed');
});

test('upload status reports deleted PDFs as terminal instead of failing the status query', async () => {
  const id = '00000000-0000-4000-8000-000000000002';
  const service = Object.create(UploadService.prototype);
  service.supabase = { select: async () => [] };
  service.queue = { getJob: async () => ({ data: { ownerId: 'owner' }, getState: async () => 'active', progress: 30 }) };
  assert.deepEqual(await service.getStatus(id, 'owner'), { jobId: id, status: 'deleted', progress: null });
  service.queue.getJob = async () => undefined;
  assert.equal((await service.getStatus(id, 'owner')).status, 'deleted');
  service.queue.getJob = async () => ({ data: { ownerId: 'someone-else' }, getState: async () => 'active' });
  await assert.rejects(service.getStatus(id, 'owner'), /Upload job not found/);
});

test('upload status reports why a quota failure removed the PDF', async () => {
  const id = '00000000-0000-4000-8000-000000000003';
  const error = 'Gemini embedding quota exceeded, so PDF indexing was stopped. The PDF was removed.';
  const service = Object.create(UploadService.prototype);
  service.supabase = { select: async () => [] };
  service.queue = { getJob: async () => ({ data: { ownerId: 'owner' }, progress: { stage: 'failed', percentage: 0, error } }) };
  assert.deepEqual(await service.getStatus(id, 'owner'), { jobId: id, status: 'failed', progress: null, error });
});
