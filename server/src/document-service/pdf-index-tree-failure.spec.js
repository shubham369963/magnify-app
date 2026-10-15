import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { PdfService } from '../../dist/document-service/pdf.service.js';

test('exhausted current tree jobs mark the project and its documents failed', async () => {
  const calls = [];
  const service = Object.create(PdfService.prototype);
  service.logger = { log() {}, warn() {}, error() {} };
  service.supabase = {
    select: async () => [{ generation: 4 }],
    rpc: async (...args) => calls.push(['rpc', ...args]),
    update: async (...args) => calls.push(['update', ...args]),
  };

  await service.markProjectTreeJobFailed({ projectId: 'project-1', ownerId: 'owner-1', generation: 4 }, new Error('PDF index failed'));

  assert.equal(calls[0][1], 'fail_project_index_tree');
  assert.equal(calls[0][2].p_error_message, 'PDF index failed');
  assert.equal(calls[1][1], 'documents');
  assert.equal(calls[1][3].processing_status, 'failed');
  assert.equal(calls[1][3].processing_error, 'PDF index failed');
});

test('stale tree jobs do not fail a newer project generation', async () => {
  const calls = [];
  const service = Object.create(PdfService.prototype);
  service.logger = { log() {}, warn() {}, error() {} };
  service.supabase = {
    select: async () => [{ generation: 5 }],
    rpc: async (...args) => calls.push(args),
    update: async (...args) => calls.push(args),
  };

  await service.markProjectTreeJobFailed({ projectId: 'project-1', ownerId: 'owner-1', generation: 4 }, new Error('stale error'));

  assert.deepEqual(calls, []);
});