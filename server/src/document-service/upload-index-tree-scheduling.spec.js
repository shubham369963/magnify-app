import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { UploadService } from '../../dist/document-service/upload.service.js';

test('project tree scheduling uses distinct queue IDs when a generation is reused', async () => {
  const jobIds = [];
  const service = Object.create(UploadService.prototype);
  service.logger = { log() {}, warn() {}, error() {} };
  service.supabase = { rpc: async () => 1 };
  service.queue = {
    add: async (_name, _data, options) => {
      jobIds.push(options.jobId);
      return { id: options.jobId };
    },
  };

  await service.scheduleProjectTree('owner-1', 'project-1');
  await service.scheduleProjectTree('owner-1', 'project-1');

  assert.equal(jobIds.length, 2);
  assert.notEqual(jobIds[0], jobIds[1]);
});