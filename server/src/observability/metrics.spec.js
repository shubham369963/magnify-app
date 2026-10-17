import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { metrics } from '../../dist/observability/metrics.js';
import { createGraphqlMetricsPlugin } from '../../dist/observability/graphql-metrics.plugin.js';
import { getTraceContext, runWithTraceContext } from '../../dist/observability/trace-context.js';
import { SupabaseService } from '../../dist/database/supabase.service.js';

test('records strategy outcomes and measured stages in the Prometheus registry', async () => {
  const ingestion = metrics.startIngestion('index_tree');
  ingestion.setOutcome('success');
  ingestion.finish();
  await metrics.trackStage('vector', 'metrics_test_stage', async () => undefined);
  await metrics.trackChat('vector', async () => 'ok');

  const output = await metrics.registry.metrics();
  assert.match(output, /magnify_ingestion_jobs_total\{[^}]*strategy="index_tree"[^}]*outcome="success"/);
  assert.match(output, /magnify_ingestion_stage_duration_seconds_count\{[^}]*stage="metrics_test_stage"/);
  assert.match(output, /magnify_chat_requests_total\{[^}]*provider="ollama"[^}]*strategy="vector"[^}]*outcome="success"/);
});

test('long ingestion and dependency calls have finite buckets beyond the old percentile ceilings', async () => {
  const dependency = metrics.registry.getSingleMetric('magnify_dependency_duration_seconds');
  dependency.observe({ system: 'latency_budget_test', operation: 'batch', outcome: 'success' }, 130);
  const values = (await dependency.get()).values.filter((value) => value.labels.system === 'latency_budget_test');
  assert.equal(values.find((value) => value.labels.le === 60).value, 0);
  assert.equal(values.find((value) => value.labels.le === 300).value, 1);

  const stage = metrics.registry.getSingleMetric('magnify_ingestion_stage_duration_seconds');
  stage.observe({ strategy: 'vector', stage: 'long_caption_test' }, 720);
  const stages = (await stage.get()).values.filter((value) => value.labels.stage === 'long_caption_test');
  assert.equal(stages.find((value) => value.labels.le === 600).value, 0);
  assert.equal(stages.find((value) => value.labels.le === 1200).value, 1);
});

test('records dependency calls, payload sizes, strategy-specific work, and trace context', async () => {
  await runWithTraceContext({ traceId: 'trace-test', requestId: 'request-test' }, async () => {
    assert.equal(getTraceContext().traceId, 'trace-test');
    await metrics.trackDependency('test_db', 'metrics_test', async () => ({ ok: true }), 12, (result) => Buffer.byteLength(JSON.stringify(result)));
  });
  metrics.observeVectorOperation('vector_query', 'success');
  metrics.observeVectorEmbeddingInput('query', 40);
  metrics.observeIndexTreeShape(5, 1024);
  metrics.observeChatContext('index_tree', 128);
  await assert.rejects(metrics.trackStage('vector', 'metrics_test_failure', async () => {
    throw new Error('test failure');
  }));

  const output = await metrics.registry.metrics();
  assert.match(output, /magnify_dependency_calls_total\{[^}]*system="test_db"[^}]*operation="metrics_test"[^}]*outcome="success"/);
  assert.match(output, /magnify_dependency_payload_bytes_count\{[^}]*system="test_db"[^}]*direction="request"/);
  assert.match(output, /magnify_dependency_payload_bytes_count\{[^}]*system="test_db"[^}]*direction="response"/);
  assert.match(output, /magnify_vector_operations_total\{[^}]*operation="vector_query"[^}]*outcome="success"/);
  assert.match(output, /magnify_vector_embedding_estimated_tokens_total\{[^}]*operation="query"/);
  assert.match(output, /magnify_index_tree_nodes_count\{/);
  assert.match(output, /magnify_index_tree_serialized_bytes_count\{/);
  assert.match(output, /magnify_chat_context_bytes_count\{[^}]*strategy="index_tree"/);
  assert.match(output, /magnify_ingestion_stage_errors_total\{[^}]*strategy="vector"[^}]*stage="metrics_test_failure"[^}]*\} 1/);
});

test('logs correlated Qdrant calls at info and emits failures only once', async () => {
  const previousInfo = console.info;
  const previousWarn = console.warn;
  const infoLogs = [];
  const warnLogs = [];
  console.info = (message) => infoLogs.push(JSON.parse(message));
  console.warn = (message) => warnLogs.push(JSON.parse(message));
  try {
    await runWithTraceContext({ traceId: 'trace-qdrant', requestId: 'request-qdrant' }, async () => {
      await metrics.trackDependency('qdrant', 'query', async () => 'ok');
      await assert.rejects(metrics.trackDependency('qdrant', 'upsert', async () => {
        throw new Error('qdrant failure');
      }));
    });
    assert.equal(infoLogs.length, 1);
    assert.equal(infoLogs[0].traceId, 'trace-qdrant');
    assert.equal(infoLogs[0].requestId, 'request-qdrant');
    assert.equal(warnLogs.length, 1);
    assert.equal(warnLogs[0].operation, 'upsert');
    assert.equal(warnLogs[0].status, 'error');
  } finally {
    console.info = previousInfo;
    console.warn = previousWarn;
  }
});

test('Supabase database requests carry correlation IDs and record response bytes', async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let observedHeaders;
  const fetchMock = async (_url, options) => {
    observedHeaders = options.headers;
    return new Response('[{"id":"row-1"}]', { status: 200, headers: { 'content-length': '16' } });
  };
  globalThis.fetch = fetchMock;
  process.env.SUPABASE_URL = 'https://supabase.example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-secret';
  try {
    await runWithTraceContext({ traceId: 'trace-db', requestId: 'request-db', documentId: 'doc-db', jobId: 'job-db' }, () =>
      new SupabaseService().select('metrics_test_table', new URLSearchParams({ select: 'id' })));
    assert.equal(observedHeaders.get('x-trace-id'), 'trace-db');
    assert.equal(observedHeaders.get('x-request-id'), 'request-db');
    assert.equal(observedHeaders.get('x-document-id'), 'doc-db');
    assert.equal(observedHeaders.get('x-job-id'), 'job-db');
    const output = await metrics.registry.metrics();
    assert.match(output, /magnify_dependency_calls_total\{[^}]*system="supabase_db"[^}]*operation="metrics_test_table"[^}]*outcome="success"/);
    assert.match(output, /magnify_dependency_payload_bytes_count\{[^}]*system="supabase_db"[^}]*operation="metrics_test_table"[^}]*direction="response"/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }
});

test('records GraphQL operations, execution errors, and early request failures', async () => {
  const quietLogger = { log() {}, warn() {} };
  const plugin = createGraphqlMetricsPlugin(quietLogger);

  const query = await plugin.requestDidStart({});
  await query.didResolveOperation({ operation: { operation: 'query' }, operationName: 'projects' });
  await query.willSendResponse({});

  const mutation = await plugin.requestDidStart({});
  await mutation.didResolveOperation({ operation: { operation: 'mutation' }, operationName: 'createProject' });
  await mutation.didEncounterErrors({ operation: { operation: 'mutation' }, errors: [{}, {}] });
  await mutation.willSendResponse({});

  await plugin.invalidRequestWasReceived({ error: new Error('invalid request') });

  const output = await metrics.registry.metrics();
  assert.match(output, /magnify_graphql_operations_total\{[^}]*operation_type="query"[^}]*outcome="success"/);
  assert.match(output, /magnify_graphql_operations_total\{[^}]*operation_type="mutation"[^}]*outcome="error"/);
  assert.match(output, /magnify_graphql_errors_total\{[^}]*operation_type="mutation"[^}]*phase="execution"[^}]*\} 2/);
  assert.match(output, /magnify_graphql_errors_total\{[^}]*operation_type="unknown"[^}]*phase="request"[^}]*\} 1/);
  assert.match(output, /magnify_graphql_active_requests\{[^}]*\} 0/);
});