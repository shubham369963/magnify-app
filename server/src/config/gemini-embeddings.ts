import { ServiceUnavailableException } from '@nestjs/common';
import { Embeddings } from '@langchain/core/embeddings';
import { metrics } from '../observability/metrics.js';
import { getTraceContext } from '../observability/trace-context.js';

const MODEL = 'gemini-embedding-2';
const DIMENSIONS = 768;
const BATCH_SIZE = 100;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 250;
const RATE_LIMIT_RETRY_DELAY_MS = 15_000;
const MAX_RETRY_AFTER_MS = 120_000;

interface GeminiBatchEmbeddingResponse {
  embeddings?: Array<{ values?: number[] }>;
}

export class GeminiEmbeddings extends Embeddings {
  private readonly apiKey: string;

  constructor(apiKey = process.env.GOOGLE_API_KEY?.trim()) {
    super({});
    if (!apiKey) {
      throw new ServiceUnavailableException('GOOGLE_API_KEY is required for hosted embeddings.');
    }
    this.apiKey = apiKey;
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
    for (let offset = 0; offset < texts.length; offset += BATCH_SIZE) {
      const batch = texts.slice(offset, offset + BATCH_SIZE);
      const operation = isQuery ? 'query' : 'document_batch';
      const body = JSON.stringify({
            requests: batch.map((text) => ({
              model: `models/${MODEL}`,
              content: {
                parts: [{
                  text: isQuery
                    ? `task: search result | query: ${text}`
                    : `title: none | text: ${text}`,
                }],
              },
              outputDimensionality: DIMENSIONS,
            })),
          });
      const finish = metrics.startDependency('gemini_embeddings', operation, Buffer.byteLength(body));
      metrics.observeVectorEmbeddingInput(isQuery ? 'query' : 'document', batch.reduce((total, text) => total + text.length, 0));
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:batchEmbedContents`;
        const headers = {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
          ...(getTraceContext()?.traceId ? { 'x-trace-id': getTraceContext()!.traceId } : {}),
          ...(getTraceContext()?.requestId ? { 'x-request-id': getTraceContext()!.requestId } : {}),
          ...(getTraceContext()?.documentId ? { 'x-document-id': getTraceContext()!.documentId } : {}),
          ...(getTraceContext()?.jobId ? { 'x-job-id': getTraceContext()!.jobId } : {}),
        };
        let response: Response | undefined;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
          try {
            response = await fetch(url, {
              method: 'POST',
              headers,
              body,
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
          } catch (error) {
            if (attempt === MAX_ATTEMPTS) throw error;
            await this.waitBeforeRetry(operation, attempt, error);
            continue;
          }

          if (response.ok) break;
          const responseDetail = (await response.text()).replace(/\s+/gu, ' ').trim().slice(0, 500);
          const failure = new Error(
            `Gemini embedding request failed (${response.status})${responseDetail ? `: ${responseDetail}` : ''}`,
          );
          const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          if (!retryable || attempt === MAX_ATTEMPTS) {
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
          || batchVectors.some((vector) => !vector || vector.length !== DIMENSIONS)
        ) {
          throw new Error(`Gemini returned invalid embeddings; expected ${batch.length} vectors of ${DIMENSIONS} dimensions.`);
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
      ? Math.min(60_000, RATE_LIMIT_RETRY_DELAY_MS * (2 ** (attempt - 1)))
      : RETRY_DELAY_MS * (2 ** (attempt - 1));
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
    return Math.min(delayMs, MAX_RETRY_AFTER_MS);
  }
}