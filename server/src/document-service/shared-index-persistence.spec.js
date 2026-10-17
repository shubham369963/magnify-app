import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, test } from '@jest/globals';
import postgres from 'postgres';
import { createDocumentTreeNode, validateProjectIndexTree } from '../../dist/document-service/index-tree.utils.js';

const databaseUrl = process.env.MAGNIFY_TEST_DATABASE_URL;
const projectId = '00000000-0000-4000-8000-000000000001';
const documentIds = [2, 3, 4].map((value) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`);
const owner = 'test-owner';
const node = (id) => createDocumentTreeNode({ id, file_name: `${id}.pdf` }, [{ pageNumber: 1, text: 'Source evidence.' }], []);

(databaseUrl ? describe : describe.skip)('shared index persistence in isolated PostgreSQL', () => {
  let sql;
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/magnify_ingestion_test',
      'Integration tests require a disposable local magnify_ingestion_test database.');
    sql = postgres(databaseUrl, { max: 4 });
    await sql.unsafe(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
      end $$;
      create table if not exists public.projects (id uuid primary key, owner_clerk_id text not null, name text not null);
      create table if not exists public.documents (
        id uuid primary key, project_id uuid references public.projects(id), owner_clerk_id text not null,
        processing_status text not null default 'pending', processing_error text,
        created_at timestamptz default now(), updated_at timestamptz default now()
      );
      create table if not exists public.project_index_trees (
        project_id uuid primary key references public.projects(id), owner_clerk_id text not null,
        tree jsonb not null default '{"type":"root","children":[]}', generation bigint not null default 0,
        status text not null default 'pending', error_message text, metadata jsonb default '{}',
        updated_at timestamptz default now()
      );
    `);
    await sql.unsafe(await readFile(new URL('../../migrations/20261017_shared_document_indexing.sql', import.meta.url), 'utf8'));
  });
  beforeEach(async () => {
    await sql`truncate public.documents, public.project_index_trees, public.projects`;
    await sql`insert into public.projects values (${projectId}, ${owner}, 'Project')`;
    for (const id of documentIds) {
      await sql`insert into public.documents (id, project_id, owner_clerk_id) values (${id}, ${projectId}, ${owner})`;
    }
  });
  afterAll(async () => { await sql?.end(); });

  async function complete(id, ownerId = owner) {
    await sql`select public.complete_document_indexing(${projectId}, ${ownerId}, ${id}, ${sql.json(node(id))})`;
  }
  async function treeRow() {
    return (await sql`select * from public.project_index_trees where project_id = ${projectId}`)[0];
  }

  test('simultaneous uploads preserve all branches and complete only after all documents finish', async () => {
    await complete(documentIds[0]);
    assert.equal((await treeRow()).status, 'processing');
    await Promise.all(documentIds.slice(1).map((id) => complete(id)));
    const row = await treeRow();
    assert.equal(row.status, 'completed');
    assert.equal(row.tree.children.length, 3);
    assert.equal(row.generation, '3');
    validateProjectIndexTree(row.tree, documentIds);
    assert.ok((await sql`select processing_status from public.documents`).every((doc) => doc.processing_status === 'completed'));
  });

  test('retries replace only their own node without duplicates', async () => {
    await Promise.all(documentIds.map((id) => complete(id)));
    await complete(documentIds[0]);
    const row = await treeRow();
    assert.equal(row.tree.children.length, 3);
    assert.equal(row.status, 'completed');
    validateProjectIndexTree(row.tree, documentIds);
  });

  test('a newly requested upload resets stale progress without discarding existing document nodes', async () => {
    await Promise.all(documentIds.map((id) => complete(id)));
    await sql`select public.request_project_index_tree(${projectId}, ${owner})`;
    const row = await treeRow();
    assert.equal(row.status, 'pending');
    assert.equal(row.metadata.percentage, 0);
    assert.equal(row.tree.children.length, 3);
  });

  test('a failed document keeps the project failed until its combined retry succeeds', async () => {
    await sql`select public.fail_document_indexing(${projectId}, ${owner}, ${documentIds[0]}, 'Embedding failed')`;
    await complete(documentIds[1]);
    assert.equal((await treeRow()).status, 'failed');
    await complete(documentIds[2]);
    await complete(documentIds[0]);
    assert.equal((await treeRow()).status, 'completed');
    assert.equal((await treeRow()).error_message, null);
  });

  test('missing documents and ownership violations cannot complete or corrupt the index', async () => {
    await complete(documentIds[0]);
    const before = await treeRow();
    await assert.rejects(complete(documentIds[1], 'other-owner'), /Project not found/);
    await sql`delete from public.documents where id = ${documentIds[1]}`;
    await assert.rejects(complete(documentIds[1]), /removed before indexing completed/);
    assert.deepEqual((await treeRow()).tree, before.tree);
    assert.equal((await treeRow()).generation, before.generation);
  });

  test('merging a new document removes branches for deleted PDFs', async () => {
    await complete(documentIds[0]);
    await sql`delete from public.documents where id = ${documentIds[0]}`;
    await complete(documentIds[1]);
    assert.deepEqual((await treeRow()).tree.source_document_ids, [documentIds[1]]);
  });

  test('a mismatched node is rejected without changing document status', async () => {
    await assert.rejects(sql`select public.complete_document_indexing(
      ${projectId}, ${owner}, ${documentIds[0]}, ${sql.json(node(documentIds[1]))}
    )`, /Invalid document index node/);
    assert.equal((await sql`select processing_status from public.documents where id = ${documentIds[0]}`)[0].processing_status, 'pending');
  });
});
