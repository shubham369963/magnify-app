import { ServiceUnavailableException } from '@nestjs/common';
import { Embeddings } from '@langchain/core/embeddings';
import { createHash } from 'node:crypto';
import { metrics } from '../observability/metrics.js';
import { getTraceContext } from '../observability/trace-context.js';
import { EmbeddingRateLimiter, sharedEmbeddingRateLimiter } from './gemini-embedding-rate-limiter.js';
import { ProviderQuotaError } from '../shared-utils/provider-quota-error.js';

type EmbeddingRateLimitUnit = 'input' | 'request';

interface GeminiEmbeddingSettings {
  model: string;
  dimensions: number;
  batchSize: number;
  batchConcurrency: number;
  maxAttempts: number;
  requestTimeoutMs: number;
  retryDelayMs: number;
  maxRetryAfterMs: number;
  rateLimitPerMinute: number;
  rateLimitUnit: EmbeddingRateLimitUnit;
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
  const batchConcurrency = process.env.GEMINI_EMBEDDING_BATCH_CONCURRENCY === undefined
    ? 2
    : positiveIntegerFromEnvironment('GEMINI_EMBEDDING_BATCH_CONCURRENCY');
  if (batchConcurrency > 32) {
    throw new ServiceUnavailableException('GEMINI_EMBEDDING_BATCH_CONCURRENCY must be between 1 and 32.');
  }
  const rawRateLimit = process.env.GEMINI_EMBEDDING_RATE_LIMIT_PER_MINUTE?.trim();
  const rateLimitPerMinute = !rawRateLimit || rawRateLimit === '0'
    ? 0
    : positiveIntegerFromEnvironment('GEMINI_EMBEDDING_RATE_LIMIT_PER_MINUTE');
  const rateLimitUnit = (process.env.GEMINI_EMBEDDING_RATE_LIMIT_UNIT?.trim() || 'input') as EmbeddingRateLimitUnit;
  if (rateLimitUnit !== 'input' && rateLimitUnit !== 'request') {
    throw new ServiceUnavailableException('GEMINI_EMBEDDING_RATE_LIMIT_UNIT must be "input" or "request".');
  }
  return {
    model,
    dimensions: positiveIntegerFromEnvironment('GEMINI_EMBEDDING_DIMENSIONS'),
    batchSize: positiveIntegerFromEnvironment('GEMINI_EMBEDDING_BATCH_SIZE'),
    batchConcurrency,
    maxAttempts: positiveIntegerFromEnvironment('GEMINI_EMBEDDING_MAX_ATTEMPTS'),
    requestTimeoutMs: positiveIntegerFromEnvironment('GEMINI_EMBEDDING_REQUEST_TIMEOUT_MS'),
    retryDelayMs: positiveIntegerFromEnvironment('GEMINI_EMBEDDING_RETRY_DELAY_MS'),
    maxRetryAfterMs: positiveIntegerFromEnvironment('GEMINI_EMBEDDING_MAX_RETRY_AFTER_MS'),
    rateLimitPerMinute,
    rateLimitUnit,
  };
}

interface GeminiBatchEmbeddingResponse {
  embeddings?: Array<{ values?: number[] }>;
}

export interface GeminiEmbeddingCheckpoint {
  model: string;
  dimensions: number;
  inputHash: string;
  vectors: Array<number[] | null>;
}

interface EmbeddingCheckpointOptions {
  checkpoint?: GeminiEmbeddingCheckpoint;
  saveCheckpoint: (checkpoint: GeminiEmbeddingCheckpoint) => Promise<void>;
}

const DOCUMENT_PROMPT_PREFIX = 'title: none | text: ';

function isEmbeddingVector(value: unknown, dimensions: number): value is number[] {
  return Array.isArray(value) && value.length === dimensions
    && value.every((component) => typeof component === 'number' && Number.isFinite(component));
}

export class GeminiEmbeddings extends Embeddings {
  private readonly apiKey: string;
  private readonly settings: GeminiEmbeddingSettings;
  private readonly batchSize: number;
  private readonly rateLimiter?: EmbeddingRateLimiter;

  constructor(
    apiKey = process.env.GOOGLE_API_KEY?.trim(),
    options: { rateLimiter?: EmbeddingRateLimiter } = {},
  ) {
    super({});
    if (!apiKey) {
      throw new ServiceUnavailableException('GOOGLE_API_KEY is required for hosted embeddings.');
    }
    this.apiKey = apiKey;
    this.settings = readGeminiEmbeddingSettings();
    const { rateLimitPerMinute, rateLimitUnit, model } = this.settings;
    // A single request can never cost more inputs than the per-minute budget allows.
    this.batchSize = rateLimitPerMinute && rateLimitUnit === 'input'
      ? Math.min(this.settings.batchSize, rateLimitPerMinute)
      : this.settings.batchSize;
    this.rateLimiter = options.rateLimiter
      ?? (rateLimitPerMinute ? sharedEmbeddingRateLimiter(model, rateLimitUnit, rateLimitPerMinute) : undefined);
  }

  async embedDocuments(texts: string[], checkpointOptions?: EmbeddingCheckpointOptions): Promise<number[][]> {
    return this.embedBatch(texts, false, checkpointOptions);
  }

  async embedQuery(text: string): Promise<number[]> {
    const [embedding] = await this.embedBatch([text], true);
    return embedding;
  }

  private async embedBatch(
    texts: string[], isQuery: boolean, checkpointOptions?: EmbeddingCheckpointOptions,
  ): Promise<number[][]> {
    const vectors = new Array<number[]>(texts.length);
    const identity = {
      model: this.settings.model,
      dimensions: this.settings.dimensions,
      inputHash: createHash('sha256').update(DOCUMENT_PROMPT_PREFIX).update(JSON.stringify(texts)).digest('hex'),
    };
    const checkpoint = checkpointOptions?.checkpoint;
    if (checkpoint) {
      const valid = checkpoint.model === identity.model && checkpoint.dimensions === identity.dimensions
        && checkpoint.inputHash === identity.inputHash && Array.isArray(checkpoint.vectors)
        && checkpoint.vectors.length === texts.length
        && checkpoint.vectors.every((vector) => vector === null || isEmbeddingVector(vector, identity.dimensions));
      if (valid) {
        checkpoint.vectors.forEach((vector, index) => {
          if (vector !== null) vectors[index] = vector;
        });
      } else {
        console.warn(JSON.stringify({
          event: 'document.embedding_checkpoint.discarded',
          reason: 'Embedding model, dimensions, inputs, or vector data did not match.',
          ...getTraceContext(),
        }));
      }
    }
    const missing = texts.flatMap((_, index) => vectors[index] === undefined ? [index] : []);
    if (checkpointOptions && missing.length < texts.length) {
      console.log(JSON.stringify({
        event: 'document.embedding_checkpoint.resume',
        reusedVectors: texts.length - missing.length,
        missingVectors: missing.length,
        ...getTraceContext(),
      }));
    }
    let checkpointWrite = Promise.resolve();
    let nextOffset = 0;
    let failed = false;
    let failure: unknown;
    const work = async () => {
      while (!failed && nextOffset < missing.length) {
        const offset = nextOffset;
        nextOffset += this.batchSize;
        try {
          const indices = missing.slice(offset, offset + this.batchSize);
          const batch = indices.map((index) => texts[index]);
          const result = await this.embedRequest(batch, isQuery);
          result.forEach((vector, index) => { vectors[indices[index]] = vector; });
          if (checkpointOptions) {
            const snapshot: GeminiEmbeddingCheckpoint = {
              ...identity,
              vectors: Array.from({ length: texts.length }, (_, index) => vectors[index] ?? null),
            };
            // Serialize atomic snapshots so a slower earlier save cannot erase a newer batch.
            checkpointWrite = checkpointWrite.then(() => checkpointOptions.saveCheckpoint(snapshot));
            await checkpointWrite;
          }
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
    };
    await Promise.all(Array.from({
      length: Math.min(this.settings.batchConcurrency, Math.ceil(missing.length / this.batchSize)),
    }, work));
    if (failed) throw failure;
    return vectors;
  }

  private async embedRequest(batch: string[], isQuery: boolean): Promise<number[][]> {
    const operation = isQuery ? 'query' : 'document_batch';
    const body = JSON.stringify({
      requests: batch.map((text) => ({
        model: `models/${this.settings.model}`,
        content: {
          parts: [{
            text: isQuery
              ? `task: search result | query: ${text}`
              : `${DOCUMENT_PROMPT_PREFIX}${text}`,
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
          await this.acquireRateLimit(operation, batch.length);
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
        const responseBody = await response.text();
        const responseDetail = responseBody.replace(/\s+/gu, ' ').trim().slice(0, 500);
        const failure = new Error(
          `Gemini embedding request failed (${response.status})${responseDetail ? `: ${responseDetail}` : ''}`,
        );
        if (response.status === 429) {
          const retryAfterMs = this.retryAfterMilliseconds(response.headers.get('retry-after'))
            ?? this.providerRetryDelayMilliseconds(responseDetail);
          if (
            retryAfterMs !== undefined
            && retryAfterMs > 0
            && retryAfterMs <= this.settings.maxRetryAfterMs
            && attempt < this.settings.maxAttempts
          ) {
            await this.waitBeforeRetry(operation, attempt, failure, String(retryAfterMs / 1000));
            continue;
          }
          throw new ProviderQuotaError('Gemini embedding', failure.message);
        }
        const retryable = response.status === 408 || response.status >= 500;
        if (!retryable || attempt === this.settings.maxAttempts) throw failure;
        await this.waitBeforeRetry(operation, attempt, failure, response.headers.get('retry-after'));
      }
      if (!response?.ok) throw new Error('Gemini embedding request did not return a response.');

      const result = await response.json() as GeminiBatchEmbeddingResponse;
      const responseBytes = Buffer.byteLength(JSON.stringify(result));
      const batchVectors = result.embeddings?.map((embedding) => embedding.values);
      if (
        !batchVectors
        || batchVectors.length !== batch.length
        || !batchVectors.every((vector): vector is number[] => isEmbeddingVector(vector, this.settings.dimensions))
      ) {
        throw new Error(`Gemini returned invalid embeddings; expected ${batch.length} vectors of ${this.settings.dimensions} dimensions.`);
      }
      finish('success', responseBytes);
      metrics.observeVectorOperation('embedding_request', 'success');
      return batchVectors;
    } catch (error) {
      finish('error');
      metrics.observeVectorOperation('embedding_request', 'error');
      metrics.logDependencyFailure('gemini_embeddings', operation, error);
      throw error;
    }
  }

  private async acquireRateLimit(operation: string, inputs: number): Promise<void> {
    if (!this.rateLimiter) return;
    const cost = this.settings.rateLimitUnit === 'input' ? inputs : 1;
    let waitedMs = 0;
    for (;;) {
      const waitMs = await this.rateLimiter.tryAcquire(cost);
      if (waitMs <= 0) break;
      waitedMs += waitMs;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    if (waitedMs > 0) {
      console.log(JSON.stringify({
        event: 'dependency.rate_limit_wait',
        system: 'gemini_embeddings',
        operation,
        cost,
        unit: this.settings.rateLimitUnit,
        limitPerMinute: this.settings.rateLimitPerMinute,
        waitedMs,
        ...getTraceContext(),
      }));
    }
  }

  private async waitBeforeRetry(
    operation: string,
    attempt: number,
    error: unknown,
    retryAfter?: string | null,
  ): Promise<void> {
    const retryAfterMs = this.retryAfterMilliseconds(retryAfter);
    const delayMs = retryAfterMs === undefined
      ? this.settings.retryDelayMs * (2 ** (attempt - 1))
      : Math.min(this.settings.maxRetryAfterMs, retryAfterMs);
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
    return delayMs;
  }

  private providerRetryDelayMilliseconds(message: string): number | undefined {
    const duration = message.match(/retry in\s+((?:\d+(?:\.\d+)?(?:h|m|s))+)/iu)?.[1];
    if (!duration) return undefined;
    const units = [...duration.matchAll(/(\d+(?:\.\d+)?)(h|m|s)/giu)];
    if (!units.length || units.map(([part]) => part).join('') !== duration) return undefined;
    const multipliers: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000 };
    return units.reduce((total, [, amount, unit]) => total + Number(amount) * multipliers[unit.toLowerCase()], 0);
  }
}