import assert from 'node:assert/strict';
import { jest, test } from '@jest/globals';

const calls = [];
const realSettings = await import('../../dist/config/settings.js');
jest.unstable_mockModule('../../dist/config/settings.js', () => ({
  ...realSettings,
  deleteDocumentVectors: async (id) => calls.push(['document-vectors', id]),
  deleteUserVectors: async (ownerId) => calls.push(['user-vectors', ownerId]),
}));
const realCheckpoints = await import('../../dist/document-service/vector-index-checkpoint.js');
jest.unstable_mockModule('../../dist/document-service/vector-index-checkpoint.js', () => ({
  ...realCheckpoints,
  deleteVectorIndexCheckpoint: async (id) => calls.push(['checkpoint', id]),
}));
const { ProjectsService } = await import('../../dist/project-service/projects.service.js');
const { UploadService } = await import('../../dist/document-service/upload.service.js');

test('account deletion removes storage (including orphans), checkpoints, rows, and vectors', async () => {
  calls.length = 0;
  const documentPages = [
    Array.from({ length: 500 }, (_, index) => ({ id: `doc-${String(index).padStart(3, '0')}`, storage_path: `user_1/p/doc-${index}/a.pdf` })),
    [{ id: 'doc-last', storage_path: 'user_1/p/doc-last/b.pdf' }],
  ];
  const queries = [];
  const service = new ProjectsService({
    select: async (table, query) => {
      queries.push(query.toString());
      return documentPages.shift() ?? [];
    },
    listObjectPaths: async (prefix) => {
      calls.push(['list', prefix]);
      return ['user_1/p/doc-last/b.pdf', 'user_1/orphan/upload/c.pdf'];
    },
    deleteObjects: async (paths) => calls.push(['storage', paths]),
    delete: async (table, query) => calls.push(['delete', table, query.toString()]),
  });
  await service.deleteUserData('user_1');

  assert.ok(queries.every((query) => query.includes('owner_clerk_id=eq.user_1')));
  assert.match(queries[1], /id=gt.doc-499/);
  assert.equal(calls.filter(([kind]) => kind === 'checkpoint').length, 501);
  const [, storagePaths] = calls.find(([kind]) => kind === 'storage');
  assert.equal(storagePaths.length, 502);
  assert.ok(storagePaths.includes('user_1/orphan/upload/c.pdf'));
  assert.deepEqual(calls.find(([kind]) => kind === 'list'), ['list', 'user_1']);
  const order = calls.map(([kind]) => kind).filter((kind) => ['storage', 'delete', 'user-vectors'].includes(kind));
  assert.deepEqual(order, ['storage', 'delete', 'user-vectors']);
  assert.deepEqual(calls.find(([kind]) => kind === 'delete'), ['delete', 'projects', 'owner_clerk_id=eq.user_1']);
});

test('account deletion rejects owner IDs that could widen the storage prefix', async () => {
  const service = new ProjectsService({
    select: async () => assert.fail('must not query'),
    listObjectPaths: async () => assert.fail('must not list storage'),
  });
  for (const ownerId of ['', 'user/../other', 'user_1/', '*']) {
    await assert.rejects(service.deleteUserData(ownerId), /Clerk user ID is invalid/);
  }
});

test('account deletion removes only that owner\'s queued and retained jobs', async () => {
  const removed = [];
  const job = (id, ownerId) => ({ id, data: { ownerId }, remove: async () => removed.push(id) });
  const service = Object.create(UploadService.prototype);
  service.logger = { warn() {} };
  let states;
  service.queue = {
    getJobs: async (requested) => {
      states = requested;
      return [job('mine-queued', 'user_1'), job('other', 'user_2'), job('mine-failed', 'user_1'), undefined];
    },
  };
  await service.removeOwnerJobs('user_1');
  assert.deepEqual(removed.sort(), ['mine-failed', 'mine-queued']);
  assert.ok(!states.includes('active'));
  assert.ok(states.includes('waiting') && states.includes('completed') && states.includes('failed'));
});

test('storage listing walks nested folders and pages, and deletes in batches', async () => {
  const { SupabaseService } = await import('../../dist/database/supabase.service.js');
  const previous = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY, fetch: globalThis.fetch };
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
  const tree = {
    user_1: [{ name: 'project', id: null }],
    'user_1/project': [...Array.from({ length: 1000 }, (_, i) => ({ name: `doc-${i}`, id: null })), { name: 'doc-1000', id: null }],
  };
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, method: init.method, body });
    if (init.method === 'DELETE') return new Response('[]', { status: 200 });
    const entries = tree[body.prefix] ?? [{ name: 'file.pdf', id: 'object-id' }];
    return new Response(JSON.stringify(entries.slice(body.offset, body.offset + body.limit)), { status: 200 });
  };
  try {
    const service = new SupabaseService();
    const paths = await service.listObjectPaths('user_1');
    assert.equal(paths.length, 1001);
    assert.ok(paths.includes('user_1/project/doc-1000/file.pdf'));
    assert.ok(requests.every(({ url }) => url === 'https://supabase.test/storage/v1/object/list/documents'));
    requests.length = 0;
    await service.deleteObjects(paths);
    assert.deepEqual(requests.map(({ body }) => body.prefixes.length), [1000, 1]);
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of [['SUPABASE_URL', previous.url], ['SUPABASE_SERVICE_ROLE_KEY', previous.key]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
