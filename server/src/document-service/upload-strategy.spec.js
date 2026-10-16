import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { MAX_PDF_SIZE_BYTES, UploadService } from '../../dist/document-service/upload.service.js';

test('PDF uploads must be smaller than 3 MB', async () => {
  const projectLookupError = new Error('Reached project lookup.');
  const service = Object.create(UploadService.prototype);
  service.projects = { get: async () => { throw projectLookupError; } };
  const createPdfBuffer = (size) => {
    const buffer = Buffer.alloc(size);
    buffer.write('%PDF-');
    return buffer;
  };

  await assert.rejects(
    service.performUpload({
      buffer: createPdfBuffer(MAX_PDF_SIZE_BYTES),
      size: MAX_PDF_SIZE_BYTES,
    }, 'owner-1', 'project-1'),
    (error) => error.status === 400 && error.message === 'PDF files must be smaller than 3 MB.',
  );
  await assert.rejects(
    service.performUpload({
      buffer: createPdfBuffer(MAX_PDF_SIZE_BYTES - 1),
      size: MAX_PDF_SIZE_BYTES - 1,
    }, 'owner-1', 'project-1'),
    (error) => error === projectLookupError,
  );
});

test('changing RAG strategy only updates the project setting', async () => {
  const calls = [];
  const service = Object.create(UploadService.prototype);
  service.projects = {
    update: async (...args) => {
      calls.push(args);
      return { id: 'project-1', rag_strategy: 'vector' };
    },
  };
  service.supabase = new Proxy({}, {
    get: () => () => assert.fail('Strategy changes must not update document status.'),
  });
  service.queue = new Proxy({}, {
    get: () => () => assert.fail('Strategy changes must not queue indexing jobs.'),
  });

  const result = await service.updateStrategy('owner-1', 'project-1', 'vector');

  assert.deepEqual(result, { id: 'project-1', rag_strategy: 'vector' });
  assert.deepEqual(calls, [['owner-1', 'project-1', { ragStrategy: 'vector' }]]);
});