import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { UploadService } from '../../dist/document-service/upload.service.js';

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