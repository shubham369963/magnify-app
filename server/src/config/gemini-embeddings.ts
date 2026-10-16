import { ServiceUnavailableException } from '@nestjs/common';
import { Embeddings } from '@langchain/core/embeddings';
import { metrics } from '../observability/metrics.js';
import { getTraceContext } from '../observability/trace-context.js';

interface GeminiEmbeddingSettings {
  model: string;
  dimensions: number;
  batchSize: number;
  maxAttempts: number;
  requestTimeoutMs: number;
  retryDelayMs: number;
  rateLimitRetryDelayMs: number;
  rateLimitMaxDelayMs: number;
  maxRetryAfterMs: number;
}

function positiveIntegerFromEnvironment(name: string): number {
  const rawValue = process.env[name]?.trim();
  const value = Number(rawValue);
  if (!rawValue || !Number.isSafeInteger(value) || value < 1) {
    throw new ServiceUnavailableException(`${name} must be set to a positive integer.`);
  }
  return value;
}

function readGeminiEmbeddingSettings(): GeminiEmbeddingSettings {
  const model = process.env.GEMINI_EMBEDDING_MODEL?.trim();
  if (!model) {
    throw new ServiceUnavailableException('GEMINI_EMBEDDING_MODEL must be set.');
  }
  return {
    model,
    dimensions: positiveIntegerFromEnvironment('GEMINI_EMBEDDING_DIMENSIONS'),
    batchSize: positiveIntegerFromEnvironment('GEMINI_EMBEDDING_BATCH_SIZE'),
    maxAttempts: positiveIntegerFromEnvironment('GEMINI_EMBEDDING_MAX_ATTEMPTS'),
    requestTimeoutMs: positiveIntegerFromEnvironment('GEMINI_EMBEDDING_REQUEST_TIMEOUT_MS'),
    retryDelayMs: positiveIntegerFromEnvironment('GEMINI_EMBEDDING_RETRY_DELAY_MS'),
    rateLimitRetryDelayMs: positiveIntegerFromEnvironment('GEMINI_EMBEDDING_RATE_LIMIT_RETRY_DELAY_MS'),
    rateLimitMaxDelayMs: positiveIntegerFromEnvironment('GEMINI_EMBEDDING_RATE_LIMIT_MAX_DELAY_MS'),
    maxRetryAfterMs: positiveIntegerFromEnvironment('GEMINI_EMBEDDING_MAX_RETRY_AFTER_MS'),
  };
}

interface GeminiBatchEmbeddingResponse {
  embeddings?: Array<{ values?: number[] }>;
}

export class GeminiEmbeddings extends Embeddings {
  private readonly apiKey: string;
  private readonly settings: GeminiEmbeddingSettings;

  constructor(apiKey = process.env.GOOGLE_API_KEY?.trim()) {
    super({});
    if (!apiKey) {
      throw new ServiceUnavailableException('GOOGLE_API_KEY is required for hosted embeddings.');
    }
    this.apiKey = apiKey;
    this.settings = readGeminiEmbeddingSettings();
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embedBatch(texts, false);
  }

  async embedQuery(text: string): Promise<number[]> {
    const [embedding] = await this.embedBatch([text], true);
    return embedding;
  }

  private async embedBatch(texts: string[], isQuery: boolean): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += this.settings.batchSize) {
      const batch = texts.slice(offset, offset + this.settings.batchSize);
      const operation = isQuery ? 'query' : 'document_batch';
      const body = JSON.stringify({
            requests: batch.map((text) => ({
              model: `models/${this.settings.model}`,
              content: {
                parts: [{
                  text: isQuery
                    ? `task: search result | query: ${text}`
                    : `title: none | text: ${text}`,
                }],
              },
              outputDimensionality: this.settings.dimensions,
            })),
          });
      const finish = metrics.startDependency('gemini_embeddings', operation, Buffer.byteLength(body));
      metrics.observeVectorEmbeddingInput(isQuery ? 'query' : 'document', batch.reduce((total, text) => total + text.length, 0));
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.settings.model}:batchEmbedContents`;
        const headers = {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
          ...(getTraceContext()?.traceId ? { 'x-trace-id': getTraceContext()!.traceId } : {}),
          ...(getTraceContext()?.requestId ? { 'x-request-id': getTraceContext()!.requestId } : {}),
          ...(getTraceContext()?.documentId ? { 'x-document-id': getTraceContext()!.documentId } : {}),
          ...(getTraceContext()?.jobId ? { 'x-job-id': getTraceContext()!.jobId } : {}),
        };
        let response: Response | undefined;
        for (let attempt = 1; attempt <= this.settings.maxAttempts; attempt += 1) {
          try {
            response = await fetch(url, {
              method: 'POST',
              headers,
              body,
              signal: AbortSignal.timeout(this.settings.requestTimeoutMs),
            });
          } catch (error) {
            if (attempt === this.settings.maxAttempts) throw error;
            await this.waitBeforeRetry(operation, attempt, error);
            continue;
          }

          if (response.ok) break;
          const responseDetail = (await response.text()).replace(/\s+/gu, ' ').trim().slice(0, 500);
          const failure = new Error(
            `Gemini embedding request failed (${response.status})${responseDetail ? `: ${responseDetail}` : ''}`,
          );
          const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          if (!retryable || attempt === this.settings.maxAttempts) {
            throw failure;
          }
          await this.waitBeforeRetry(
            operation,
            attempt,
            failure,
            response.status,
            response.headers.get('retry-after'),
          );
        }
        if (!response?.ok) throw new Error('Gemini embedding request did not return a response.');

        const result = await response.json() as GeminiBatchEmbeddingResponse;
        const responseBytes = Buffer.byteLength(JSON.stringify(result));
        const batchVectors = result.embeddings?.map((embedding) => embedding.values);
        if (
          !batchVectors
          || batchVectors.length !== batch.length
          || batchVectors.some((vector) => !vector || vector.length !== this.settings.dimensions)
        ) {
          throw new Error(`Gemini returned invalid embeddings; expected ${batch.length} vectors of ${this.settings.dimensions} dimensions.`);
        }
        finish('success', responseBytes);
        metrics.observeVectorOperation('embedding_request', 'success');
        vectors.push(...batchVectors as number[][]);
      } catch (error) {
        finish('error');
        metrics.observeVectorOperation('embedding_request', 'error');
        metrics.logDependencyFailure('gemini_embeddings', operation, error);
        throw error;
      }
    }
    return vectors;
  }

  private async waitBeforeRetry(
    operation: string,
    attempt: number,
    error: unknown,
    status?: number,
    retryAfter?: string | null,
  ): Promise<void> {
    const retryAfterMs = this.retryAfterMilliseconds(retryAfter);
    const fallbackDelay = status === 429
      ? Math.min(this.settings.rateLimitMaxDelayMs, this.settings.rateLimitRetryDelayMs * (2 ** (attempt - 1)))
      : this.settings.retryDelayMs * (2 ** (attempt - 1));
    const delayMs = retryAfterMs ?? fallbackDelay;
    const errorName = error instanceof Error ? error.name : 'Error';
    console.warn(JSON.stringify({
      event: 'dependency.retry',
      system: 'gemini_embeddings',
      operation,
      attempt,
      delayMs,
      errorName,
    }));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  private retryAfterMilliseconds(value?: string | null): number | undefined {
    if (!value) return undefined;
    const seconds = Number(value);
    const delayMs = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(value) - Date.now();
    if (!Number.isFinite(delayMs) || delayMs < 0) return undefined;
    return Math.min(delayMs, this.settings.maxRetryAfterMs);
  }
}