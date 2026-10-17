import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import { getTraceContext } from './trace-context.js';

export type RagStrategy = 'vector' | 'index_tree';
export type IngestionStrategy = RagStrategy | 'both';
export type MetricOutcome = 'success' | 'error' | 'stale';
export type GraphqlOperationType = 'query' | 'mutation' | 'subscription' | 'unknown';
export type GraphqlErrorPhase = 'request' | 'execution';

const modelProvider = 'ollama';

const registry = new Registry();
const defaultService = process.argv.some((argument) => /(?:^|\/)worker\.(?:js|ts)$/.test(argument))
  ? 'magnify-worker'
  : 'magnify-api';
registry.setDefaultLabels({ service: process.env.METRICS_SERVICE_NAME || defaultService });
collectDefaultMetrics({ register: registry });

const ingestionJobs = new Counter({
  name: 'magnify_ingestion_jobs_total',
  help: 'Completed or failed PDF indexing jobs.',
  labelNames: ['strategy', 'outcome'] as const,
  registers: [registry],
});

const ingestionDuration = new Histogram({
  name: 'magnify_ingestion_duration_seconds',
  help: 'End-to-end PDF indexing duration.',
  labelNames: ['strategy', 'outcome'] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1200],
  registers: [registry],
});

const ingestionStageDuration = new Histogram({
  name: 'magnify_ingestion_stage_duration_seconds',
  help: 'Duration of individual PDF indexing stages.',
  labelNames: ['strategy', 'stage'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600],
  registers: [registry],
});

const ingestionUnits = new Counter({
  name: 'magnify_ingestion_units_total',
  help: 'Documents, pages, passages, and image captions processed during indexing.',
  labelNames: ['strategy', 'unit'] as const,
  registers: [registry],
});

const chatRequests = new Counter({
  name: 'magnify_chat_requests_total',
  help: 'Chat requests completed or failed by provider and RAG strategy.',
  labelNames: ['provider', 'strategy', 'outcome'] as const,
  registers: [registry],
});

const chatDuration = new Histogram({
  name: 'magnify_chat_duration_seconds',
  help: 'End-to-end chat request duration by provider and RAG strategy.',
  labelNames: ['provider', 'strategy', 'outcome'] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 45, 90, 180],
  registers: [registry],
});

const chatStageDuration = new Histogram({
  name: 'magnify_chat_stage_duration_seconds',
  help: 'Duration of individual chat and retrieval stages by provider.',
  labelNames: ['provider', 'strategy', 'stage'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 45, 90, 180],
  registers: [registry],
});

const chatEvidence = new Histogram({
  name: 'magnify_chat_evidence_count',
  help: 'Number of candidates and selected evidence passages during retrieval.',
  labelNames: ['strategy', 'phase'] as const,
  buckets: [0, 1, 2, 3, 5, 8, 10, 20, 50, 100, 250, 500],
  registers: [registry],
});

const modelCalls = new Counter({
  name: 'magnify_model_calls_total',
  help: 'Model calls by provider, RAG strategy, operation, and outcome.',
  labelNames: ['provider', 'strategy', 'operation', 'outcome'] as const,
  registers: [registry],
});

const modelCallDuration = new Histogram({
  name: 'magnify_model_call_duration_seconds',
  help: 'Model call duration by provider, RAG strategy, and operation.',
  labelNames: ['provider', 'strategy', 'operation'] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 45, 90, 180, 300],
  registers: [registry],
});

const modelTokens = new Counter({
  name: 'magnify_model_tokens_total',
  help: 'Token usage reported by model responses, when available, by provider.',
  labelNames: ['provider', 'strategy', 'operation', 'direction'] as const,
  registers: [registry],
});

const workerActiveJobs = new Gauge({
  name: 'magnify_worker_active_jobs',
  help: 'Number of PDF indexing jobs currently active in the worker.',
  labelNames: ['strategy'] as const,
  registers: [registry],
});

const workerQueueWait = new Histogram({
  name: 'magnify_worker_queue_wait_seconds',
  help: 'Initial queue wait, excluding retry and stalled-job reactivations.',
  labelNames: ['strategy'] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 15, 30, 60, 120, 300, 600, 900, 1800, 3600],
  registers: [registry],
});

const graphqlOperations = new Counter({
  name: 'magnify_graphql_operations_total',
  help: 'GraphQL operations completed by operation type and outcome.',
  labelNames: ['operation_type', 'outcome'] as const,
  registers: [registry],
});

const graphqlOperationDuration = new Histogram({
  name: 'magnify_graphql_operation_duration_seconds',
  help: 'End-to-end GraphQL request duration by operation type and outcome.',
  labelNames: ['operation_type', 'outcome'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

const graphqlErrors = new Counter({
  name: 'magnify_graphql_errors_total',
  help: 'GraphQL errors by operation type and request or execution phase.',
  labelNames: ['operation_type', 'phase'] as const,
  registers: [registry],
});

const graphqlActiveRequests = new Gauge({
  name: 'magnify_graphql_active_requests',
  help: 'Number of GraphQL requests currently being processed.',
  registers: [registry],
});

const dependencyCalls = new Counter({
  name: 'magnify_dependency_calls_total',
  help: 'External database, storage, vector, and embedding calls by operation and outcome.',
  labelNames: ['system', 'operation', 'outcome'] as const,
  registers: [registry],
});

const dependencyDuration = new Histogram({
  name: 'magnify_dependency_duration_seconds',
  help: 'External dependency call duration by system, operation, and outcome.',
  labelNames: ['system', 'operation', 'outcome'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1200, 1800, 3600],
  registers: [registry],
});

const dependencyPayloadBytes = new Histogram({
  name: 'magnify_dependency_payload_bytes',
  help: 'Request body bytes and response Content-Length observed at dependency boundaries.',
  labelNames: ['system', 'operation', 'direction'] as const,
  buckets: [128, 512, 2048, 8192, 32768, 131072, 524288, 2097152, 8388608, 33554432],
  registers: [registry],
});

const workerJobDuration = new Histogram({
  name: 'magnify_worker_job_duration_seconds',
  help: 'Worker processing duration, excluding time spent waiting in the queue.',
  labelNames: ['strategy', 'outcome'] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 15, 30, 60, 120, 300, 600, 1200],
  registers: [registry],
});

const workerJobRetries = new Counter({
  name: 'magnify_worker_job_retries_total',
  help: 'Worker job attempts that failed and may be retried.',
  labelNames: ['strategy'] as const,
  registers: [registry],
});

const workerJobAttempts = new Counter({
  name: 'magnify_worker_job_attempts_total',
  help: 'Worker job attempts started, succeeded, or failed by strategy.',
  labelNames: ['strategy', 'outcome'] as const,
  registers: [registry],
});

const uploadBytes = new Counter({
  name: 'magnify_upload_bytes_total',
  help: 'PDF bytes accepted for storage, counted cumulatively (not allocated storage usage).',
  labelNames: ['operation'] as const,
  registers: [registry],
});

const vectorOperations = new Counter({
  name: 'magnify_vector_operations_total',
  help: 'Vector strategy embedding and Qdrant operations by operation and outcome.',
  labelNames: ['operation', 'outcome'] as const,
  registers: [registry],
});

const vectorEmbeddingTokens = new Counter({
  name: 'magnify_vector_embedding_estimated_tokens_total',
  help: 'Estimated input tokens submitted for vector embeddings (characters divided by four).',
  labelNames: ['operation'] as const,
  registers: [registry],
});

const treeNodeCount = new Histogram({
  name: 'magnify_index_tree_nodes',
  help: 'Node count per generated project index tree.',
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 10000, 50000, 100000],
  registers: [registry],
});

const treeSerializedBytes = new Histogram({
  name: 'magnify_index_tree_serialized_bytes',
  help: 'Serialized JSON payload size per generated project index tree.',
  buckets: [128, 512, 2048, 8192, 32768, 131072, 524288, 2097152, 8388608, 33554432, 67108864],
  registers: [registry],
});

const chatContextBytes = new Histogram({
  name: 'magnify_chat_context_bytes',
  help: 'Serialized evidence context size provided to answer generation.',
  labelNames: ['strategy'] as const,
  buckets: [128, 512, 2048, 8192, 32768, 131072, 524288, 2097152],
  registers: [registry],
});

const ingestionStageErrors = new Counter({
  name: 'magnify_ingestion_stage_errors_total',
  help: 'Failed ingestion stages by strategy and stage.',
  labelNames: ['strategy', 'stage'] as const,
  registers: [registry],
});

const chatStageErrors = new Counter({
  name: 'magnify_chat_stage_errors_total',
  help: 'Failed retrieval and answer stages by strategy and stage.',
  labelNames: ['strategy', 'stage'] as const,
  registers: [registry],
});

export interface ModelTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export function modelTokenUsage(response: unknown): ModelTokenUsage | null {
  if (!response || typeof response !== 'object') return null;
  const usage = (response as { usage_metadata?: unknown }).usage_metadata;
  if (!usage || typeof usage !== 'object') return null;
  const values = usage as { input_tokens?: unknown; output_tokens?: unknown };
  return {
    inputTokens: typeof values.input_tokens === 'number' ? values.input_tokens : null,
    outputTokens: typeof values.output_tokens === 'number' ? values.output_tokens : null,
  };
}

function tokenUsage(response: unknown): { input: number; output: number } {
  const usage = modelTokenUsage(response);
  return {
    input: usage?.inputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
  };
}

export const metrics = {
  registry,

  startGraphqlRequest() {
    graphqlActiveRequests.inc();
    const stop = graphqlOperationDuration.startTimer();
    let finished = false;
    return {
      observeErrors(operationType: GraphqlOperationType, phase: GraphqlErrorPhase, count: number) {
        if (count > 0) graphqlErrors.inc({ operation_type: operationType, phase }, count);
      },
      finish(operationType: GraphqlOperationType, outcome: 'success' | 'error') {
        if (finished) return;
        finished = true;
        graphqlOperations.inc({ operation_type: operationType, outcome });
        stop({ operation_type: operationType, outcome });
        graphqlActiveRequests.dec();
      },
    };
  },

  startIngestion(strategy: IngestionStrategy) {
    const stop = ingestionDuration.startTimer({ strategy });
    let outcome: MetricOutcome = 'error';
    return {
      setOutcome(value: MetricOutcome) {
        outcome = value;
      },
      finish() {
        ingestionJobs.inc({ strategy, outcome });
        stop({ outcome });
      },
    };
  },

  startIngestionStage(strategy: IngestionStrategy, stage: string) {
    return ingestionStageDuration.startTimer({ strategy, stage });
  },

  async trackStage<T>(strategy: IngestionStrategy, stage: string, task: () => Promise<T>): Promise<T> {
    const stop = ingestionStageDuration.startTimer({ strategy, stage });
    try {
      return await task();
    } catch (error) {
      ingestionStageErrors.inc({ strategy, stage });
      throw error;
    } finally {
      stop();
    }
  },

  trackStageSync<T>(strategy: IngestionStrategy, stage: string, task: () => T): T {
    const stop = ingestionStageDuration.startTimer({ strategy, stage });
    try {
      return task();
    } catch (error) {
      ingestionStageErrors.inc({ strategy, stage });
      throw error;
    } finally {
      stop();
    }
  },

  addIngestionUnits(strategy: IngestionStrategy, unit: string, amount = 1) {
    if (amount > 0) ingestionUnits.inc({ strategy, unit }, amount);
  },

  startChat(strategy: RagStrategy) {
    const stop = chatDuration.startTimer({ provider: modelProvider, strategy });
    let outcome: MetricOutcome = 'error';
    return {
      setOutcome(value: MetricOutcome) {
        outcome = value;
      },
      finish() {
        chatRequests.inc({ provider: modelProvider, strategy, outcome });
        stop({ provider: modelProvider, outcome });
      },
    };
  },

  async trackChat<T>(strategy: RagStrategy, task: () => Promise<T>): Promise<T> {
    const timer = this.startChat(strategy);
    try {
      const result = await task();
      timer.setOutcome('success');
      return result;
    } finally {
      timer.finish();
    }
  },

  startChatStage(strategy: RagStrategy, stage: string) {
    return chatStageDuration.startTimer({ provider: modelProvider, strategy, stage });
  },

  async trackChatStage<T>(strategy: RagStrategy, stage: string, task: () => Promise<T>): Promise<T> {
    const stop = chatStageDuration.startTimer({ provider: modelProvider, strategy, stage });
    try {
      return await task();
    } catch (error) {
      chatStageErrors.inc({ strategy, stage });
      throw error;
    } finally {
      stop();
    }
  },

  trackChatStageSync<T>(strategy: RagStrategy, stage: string, task: () => T): T {
    const stop = chatStageDuration.startTimer({ provider: modelProvider, strategy, stage });
    try {
      return task();
    } catch (error) {
      chatStageErrors.inc({ strategy, stage });
      throw error;
    } finally {
      stop();
    }
  },

  observeEvidence(strategy: RagStrategy, phase: 'retrieved' | 'candidates' | 'selected' | 'context_expanded', count: number) {
    chatEvidence.observe({ strategy, phase }, count);
  },

  async trackModelCall<T>(strategy: IngestionStrategy, operation: string, call: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    const stop = modelCallDuration.startTimer({ provider: modelProvider, strategy, operation });
    let outcome: MetricOutcome = 'error';
    try {
      const response = await call();
      outcome = 'success';
      const usage = tokenUsage(response);
      if (usage.input) modelTokens.inc({ provider: modelProvider, strategy, operation, direction: 'input' }, usage.input);
      if (usage.output) modelTokens.inc({ provider: modelProvider, strategy, operation, direction: 'output' }, usage.output);
      return response;
    } finally {
      modelCalls.inc({ provider: modelProvider, strategy, operation, outcome });
      stop({ provider: modelProvider });
      console.info(JSON.stringify({
        event: 'model.call',
        status: outcome,
        provider: modelProvider,
        strategy,
        operation,
        durationMs: Date.now() - startedAt,
        traceId: getTraceContext()?.traceId,
        requestId: getTraceContext()?.requestId,
        documentId: getTraceContext()?.documentId,
        jobId: getTraceContext()?.jobId,
      }));
    }
  },

  observeWorkerActive(strategy: IngestionStrategy, delta: 1 | -1) {
    workerActiveJobs.inc({ strategy }, delta);
  },

  observeWorkerQueueWait(strategy: IngestionStrategy, seconds: number) {
    workerQueueWait.observe({ strategy }, Math.max(0, seconds));
  },

  startDependency(system: string, operation: string, requestBytes = 0) {
    const startedAt = Date.now();
    const stop = dependencyDuration.startTimer({ system, operation });
    if (requestBytes > 0) dependencyPayloadBytes.observe({ system, operation, direction: 'request' }, requestBytes);
    let finished = false;
    return (outcome: 'success' | 'error', responseBytes = 0) => {
      if (finished) return;
      finished = true;
      dependencyCalls.inc({ system, operation, outcome });
      stop({ outcome });
      if (responseBytes > 0) dependencyPayloadBytes.observe({ system, operation, direction: 'response' }, responseBytes);
      const durationMs = Date.now() - startedAt;
      if (system === 'qdrant' || outcome === 'error' || durationMs >= 500) {
        const log = outcome === 'error' || durationMs >= 500 ? console.warn : console.info;
        log(JSON.stringify({
          event: 'dependency.call',
          status: outcome,
          system,
          operation,
          durationMs,
          traceId: getTraceContext()?.traceId,
          requestId: getTraceContext()?.requestId,
          documentId: getTraceContext()?.documentId,
          jobId: getTraceContext()?.jobId,
        }));
      }
    };
  },

  async trackDependency<T>(
    system: string,
    operation: string,
    task: () => Promise<T>,
    requestBytes = 0,
    responseBytes: (result: T) => number = () => 0,
  ): Promise<T> {
    const finish = this.startDependency(system, operation, requestBytes);
    try {
      const result = await task();
      finish('success', responseBytes(result));
      return result;
    } catch (error) {
      finish('error');
      throw error;
    }
  },

  observeDependencyPayload(system: string, operation: string, direction: 'request' | 'response', bytes: number) {
    if (bytes > 0) dependencyPayloadBytes.observe({ system, operation, direction }, bytes);
  },

  observeWorkerJobDuration(strategy: IngestionStrategy, outcome: 'success' | 'error' | 'stale', seconds: number) {
    workerJobDuration.observe({ strategy, outcome }, Math.max(0, seconds));
  },

  observeWorkerRetry(strategy: IngestionStrategy) {
    workerJobRetries.inc({ strategy });
  },

  observeWorkerAttempt(strategy: IngestionStrategy, outcome: 'started' | 'success' | 'error') {
    workerJobAttempts.inc({ strategy, outcome });
  },

  observeUploadBytes(operation: 'accepted' | 'deleted', bytes: number) {
    if (bytes > 0) uploadBytes.inc({ operation }, bytes);
  },

  observeVectorOperation(operation: 'embedding_request' | 'vector_write' | 'vector_query', outcome: 'success' | 'error') {
    vectorOperations.inc({ operation, outcome });
  },

  observeVectorEmbeddingInput(operation: 'document' | 'query', characters: number) {
    if (characters > 0) vectorEmbeddingTokens.inc({ operation }, Math.ceil(characters / 4));
  },

  observeIndexTreeShape(nodeCount: number, serializedBytes: number) {
    treeNodeCount.observe(nodeCount);
    treeSerializedBytes.observe(serializedBytes);
  },

  observeChatContext(strategy: RagStrategy, serializedBytes: number) {
    chatContextBytes.observe({ strategy }, serializedBytes);
  },

  logDependencyFailure(system: string, operation: string, error: unknown) {
    const failure = error instanceof Error ? error : new Error(String(error));
    console.warn(JSON.stringify({
      event: 'dependency.call',
      status: 'error',
      system,
      operation,
      traceId: getTraceContext()?.traceId,
      requestId: getTraceContext()?.requestId,
      errorName: failure.name,
    }));
  },
};