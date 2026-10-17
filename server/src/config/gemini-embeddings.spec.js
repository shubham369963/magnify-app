import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import { UnrecoverableError } from 'bullmq';
import { GeminiEmbeddings } from '../../dist/config/gemini-embeddings.js';
import { ProviderQuotaError } from '../../dist/shared-utils/provider-quota-error.js';
import {
  FallbackRateLimiter, MemorySlidingWindowRateLimiter, RedisSlidingWindowRateLimiter,
} from '../../dist/config/gemini-embedding-rate-limiter.js';
import {
  deleteVectorIndexCheckpoint, loadVectorIndexCheckpoint, saveVectorIndexCheckpoint,
} from '../../dist/document-service/vector-index-checkpoint.js';

const embeddingSettings = {
  GEMINI_EMBEDDING_MODEL: 'gemini-embedding-2',
  GEMINI_EMBEDDING_DIMENSIONS: '768',
  GEMINI_EMBEDDING_BATCH_SIZE: '100',
  GEMINI_EMBEDDING_BATCH_CONCURRENCY: '2',
  GEMINI_EMBEDDING_MAX_ATTEMPTS: '3',
  GEMINI_EMBEDDING_REQUEST_TIMEOUT_MS: '60000',
  GEMINI_EMBEDDING_RETRY_DELAY_MS: '250',
  GEMINI_EMBEDDING_MAX_RETRY_AFTER_MS: '120000',
  GEMINI_EMBEDDING_RATE_LIMIT_PER_MINUTE: '0',
  GEMINI_EMBEDDING_RATE_LIMIT_UNIT: 'input',
};
const previousEmbeddingSettings = Object.fromEntries(
  Object.keys(embeddingSettings).map((key) => [key, process.env[key]]),
);

beforeEach(() => Object.assign(process.env, embeddingSettings));
afterEach(() => {
  for (const [key, value] of Object.entries(previousEmbeddingSettings)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('Gemini embeddings use retrieval prompts and return 768-dimensional vectors', async () => {
  const previousKey = process.env.GOOGLE_API_KEY;
  const previousFetch = globalThis.fetch;
  delete process.env.GOOGLE_API_KEY;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ embeddings: [{ values: Array(768).fill(0.1) }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const embeddings = new GeminiEmbeddings('test-only-key');
    const vector = await embeddings.embedQuery('where is the result?');
    const body = JSON.parse(request.options.body);
    assert.equal(vector.length, 768);
    assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents');
    assert.equal(request.options.headers['x-goog-api-key'], 'test-only-key');
    assert.equal(body.requests[0].outputDimensionality, 768);
    assert.equal(body.requests[0].content.parts[0].text, 'task: search result | query: where is the result?');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = previousKey;
  }
});

test('Gemini model, dimensions, and batch size are configurable', async () => {
  const previousFetch = globalThis.fetch;
  process.env.GEMINI_EMBEDDING_MODEL = 'gemini-test-model';
  process.env.GEMINI_EMBEDDING_DIMENSIONS = '3';
  process.env.GEMINI_EMBEDDING_BATCH_SIZE = '1';
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ embeddings: [{ values: [0.1, 0.2, 0.3] }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const vectors = await new GeminiEmbeddings('test-only-key').embedDocuments(['one', 'two']);
    assert.equal(vectors.length, 2);
    assert.ok(vectors.every((vector) => vector.length === 3));
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.url.endsWith('/gemini-test-model:batchEmbedContents')));
    assert.ok(requests.every((request) => request.body.requests[0].outputDimensionality === 3));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Gemini embeddings require an API key', () => {
  const previousKey = process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  try {
    assert.throws(() => new GeminiEmbeddings(), ServiceUnavailableException);
  } finally {
    if (previousKey !== undefined) process.env.GOOGLE_API_KEY = previousKey;
  }
});

test('Gemini embeddings retry transient errors before succeeding', async () => {
  const previousFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) return new Response('', { status: 503 });
    return new Response(JSON.stringify({ embeddings: [{ values: Array(768).fill(0.1) }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const [vector] = await new GeminiEmbeddings('test-only-key').embedDocuments(['retry me']);
    assert.equal(vector.length, 768);
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test.each([
  ['a bare 429', ''],
  ['a short provider retry delay', JSON.stringify({ error: { message: 'Quota exceeded. Please retry in 0.01s.' } })],
  ['a daily quota reset', JSON.stringify({ error: {
    message: 'Quota exceeded for metric: embed_content_free_tier_requests. Please retry in 10h3m41.16s.',
    status: 'RESOURCE_EXHAUSTED',
  } })],
])('any Gemini 429 (%s) stops immediately without retries', async (_name, body) => {
  const previousTimeout = globalThis.setTimeout;
  const delays = [];
  let attempts = 0;
  globalThis.setTimeout = (callback, delay) => { delays.push(delay); callback(); return 0; };
  try {
    await withFetch(async () => {
      attempts += 1;
      return new Response(body, { status: 429, headers: { 'Retry-After': '1' } });
    }, async () => {
      await assert.rejects(new GeminiEmbeddings('test-key').embedDocuments(['source']), (error) =>
        error instanceof ProviderQuotaError && error instanceof UnrecoverableError
          && /Gemini embedding quota exceeded/.test(error.message) && /\(429\)/.test(error.detail));
    });
    assert.equal(attempts, 1);
    assert.deepEqual(delays, []);
  } finally {
    globalThis.setTimeout = previousTimeout;
  }
});

test('a Gemini quota error stops further embedding batches', async () => {
  Object.assign(process.env, { GEMINI_EMBEDDING_DIMENSIONS: '1', GEMINI_EMBEDDING_BATCH_SIZE: '1', GEMINI_EMBEDDING_BATCH_CONCURRENCY: '1' });
  const requests = [];
  await withFetch(async (_url, options) => {
    requests.push(JSON.parse(options.body).requests[0].content.parts[0].text);
    return requests.length === 2 ? new Response('', { status: 429 }) : Response.json({ embeddings: [{ values: [1] }] });
  }, async () => {
    await assert.rejects(new GeminiEmbeddings('test-key').embedDocuments(['0', '1', '2', '3']), ProviderQuotaError);
  });
  assert.equal(requests.length, 2);
});

test.each([
  ['2', 2000],
  ['300', 120000],
])('transient 503 responses honor Retry-After %s up to the configured maximum', async (retryAfter, delayMs) => {
  const previousTimeout = globalThis.setTimeout;
  const delays = [];
  let attempts = 0;
  globalThis.setTimeout = (callback, delay) => { delays.push(delay); callback(); return 0; };
  try {
    await withFetch(async () => {
      attempts += 1;
      return attempts === 1
        ? new Response('', { status: 503, headers: { 'Retry-After': retryAfter } })
        : Response.json({ embeddings: [{ values: Array(768).fill(0.1) }] });
    }, async () => {
      const [vector] = await new GeminiEmbeddings('test-key').embedDocuments(['retry']);
      assert.equal(vector.length, 768);
    });
    assert.deepEqual(delays, [delayMs]);
  } finally {
    globalThis.setTimeout = previousTimeout;
  }
});

test('Gemini embeddings do not retry permanent client errors', async () => {
  const previousFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response('', { status: 400 });
  };
  try {
    await assert.rejects(
      () => new GeminiEmbeddings('test-only-key').embedDocuments(['invalid request']),
      /Gemini embedding request failed \(400\)/,
    );
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('embedding batches overlap within the limit and retain input order despite out-of-order completion', async () => {
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, {
    GEMINI_EMBEDDING_DIMENSIONS: '1', GEMINI_EMBEDDING_BATCH_SIZE: '2', GEMINI_EMBEDDING_BATCH_CONCURRENCY: '2',
  });
  let active = 0;
  let maximum = 0;
  const completed = [];
  let releaseFirst;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  globalThis.fetch = async (_url, options) => {
    const texts = JSON.parse(options.body).requests.map((request) => Number(request.content.parts[0].text.split('text: ')[1]));
    active += 1;
    maximum = Math.max(maximum, active);
    if (texts[0] === 0) await firstPending;
    if (texts[0] === 4) releaseFirst();
    active -= 1;
    completed.push(texts[0]);
    return Response.json({ embeddings: texts.map((value) => ({ values: [value] })) });
  };
  try {
    const vectors = await new GeminiEmbeddings('test-key').embedDocuments(['0', '1', '2', '3', '4']);
    assert.deepEqual(JSON.parse(JSON.stringify(vectors)), [[0], [1], [2], [3], [4]]);
    assert.equal(maximum, 2);
    assert.deepEqual(completed, [2, 4, 0]);
  } finally {
    releaseFirst();
    globalThis.fetch = previousFetch;
  }
});

test('embedding failure stops pending batches and drains in-flight requests before rejecting', async () => {
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, {
    GEMINI_EMBEDDING_DIMENSIONS: '1', GEMINI_EMBEDDING_BATCH_SIZE: '1', GEMINI_EMBEDDING_MAX_ATTEMPTS: '1',
  });
  const started = [];
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let failed;
  const failureStarted = new Promise((resolve) => { failed = resolve; });
  globalThis.fetch = async (_url, options) => {
    const text = JSON.parse(options.body).requests[0].content.parts[0].text;
    started.push(text);
    if (text.endsWith('first')) {
      failed();
      return new Response('', { status: 400 });
    }
    await pending;
    return Response.json({ embeddings: [{ values: [1] }] });
  };
  try {
    let settled = false;
    const result = new GeminiEmbeddings('test-key').embedDocuments(['first', 'second', 'never'])
      .then(() => { settled = true; }, (error) => { settled = true; return error; });
    await failureStarted;
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(settled, false);
    assert.equal(started.length, 2);
    release();
    assert.match((await result).message, /400/);
    assert.equal(started.length, 2);
  } finally {
    release();
    globalThis.fetch = previousFetch;
  }
});

test('embedding concurrency allows sequential override and rejects invalid limits', async () => {
  for (const value of ['', '0', '-1', '1.5', '33', 'NaN']) {
    process.env.GEMINI_EMBEDDING_BATCH_CONCURRENCY = value;
    assert.throws(() => new GeminiEmbeddings('test-key'), /GEMINI_EMBEDDING_BATCH_CONCURRENCY/);
  }
  process.env.GEMINI_EMBEDDING_BATCH_CONCURRENCY = '1';
  const previousFetch = globalThis.fetch;
  let active = 0;
  let maximum = 0;
  process.env.GEMINI_EMBEDDING_BATCH_SIZE = '1';
  globalThis.fetch = async () => {
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    return Response.json({ embeddings: [{ values: Array(768).fill(1) }] });
  };
  try {
    await new GeminiEmbeddings('test-key').embedDocuments(['one', 'two']);
    assert.equal(maximum, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('successful batches survive a process restart on disk and only missing texts are requested with a new batch size', async () => {
  const previousFetch = globalThis.fetch;
  const previousDirectory = process.env.PDF_INDEX_CHECKPOINT_DIR;
  const directory = await mkdtemp(join(tmpdir(), 'embedding-resume-test-'));
  process.env.PDF_INDEX_CHECKPOINT_DIR = directory;
  Object.assign(process.env, {
    GEMINI_EMBEDDING_DIMENSIONS: '1', GEMINI_EMBEDDING_BATCH_SIZE: '2',
    GEMINI_EMBEDDING_BATCH_CONCURRENCY: '1', GEMINI_EMBEDDING_MAX_ATTEMPTS: '1',
  });
  const identity = { documentId: 'document-1', projectId: 'project-1', ownerId: 'owner-1', storagePath: 'source.pdf' };
  const texts = ['0', '1', '2', '3', '4'];
  const prepared = { ...identity, documents: texts.map((pageContent) => ({ pageContent, metadata: {} })) };
  const requests = [];
  let quotaExceeded = true;
  globalThis.fetch = async (_url, options) => {
    const batch = JSON.parse(options.body).requests.map(({ content }) => content.parts[0].text.slice('title: none | text: '.length));
    requests.push(batch);
    if (batch[0] === '2' && quotaExceeded) return new Response('Service unavailable', { status: 503 });
    return Response.json({ embeddings: batch.map((text) => ({ values: [Number(text)] })) });
  };
  const saveCheckpoint = (embeddings) => saveVectorIndexCheckpoint({ ...prepared, embeddings });
  try {
    await assert.rejects(new GeminiEmbeddings('test-key').embedDocuments(texts, { saveCheckpoint }), /503/);
    const saved = await loadVectorIndexCheckpoint(identity);
    assert.deepEqual(saved.embeddings.vectors, [[0], [1], null, null, null]);
    assert.deepEqual(saved.documents, prepared.documents);
    quotaExceeded = false;
    process.env.GEMINI_EMBEDDING_BATCH_SIZE = '3';
    const resumed = await new GeminiEmbeddings('test-key').embedDocuments(texts, {
      checkpoint: saved.embeddings, saveCheckpoint,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(resumed)), [[0], [1], [2], [3], [4]]);
    assert.deepEqual(requests, [['0', '1'], ['2', '3'], ['2', '3', '4']]);
    const completed = await loadVectorIndexCheckpoint(identity);
    assert.deepEqual(completed.embeddings.vectors, JSON.parse(JSON.stringify(resumed)));
    const requestCount = requests.length;
    await new GeminiEmbeddings('test-key').embedDocuments(texts, {
      checkpoint: completed.embeddings, saveCheckpoint,
    });
    assert.equal(requests.length, requestCount, 'a complete embedding checkpoint must not call Gemini again');
    await deleteVectorIndexCheckpoint(identity.documentId);
    assert.equal(await loadVectorIndexCheckpoint(identity), undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDirectory === undefined) delete process.env.PDF_INDEX_CHECKPOINT_DIR;
    else process.env.PDF_INDEX_CHECKPOINT_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test('parallel embedding success is checkpointed even when another in-flight batch fails', async () => {
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, {
    GEMINI_EMBEDDING_DIMENSIONS: '1', GEMINI_EMBEDDING_BATCH_SIZE: '1',
    GEMINI_EMBEDDING_BATCH_CONCURRENCY: '2', GEMINI_EMBEDDING_MAX_ATTEMPTS: '1',
  });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const requests = [];
  let saved;
  globalThis.fetch = async (_url, options) => {
    const text = JSON.parse(options.body).requests[0].content.parts[0].text.slice('title: none | text: '.length);
    requests.push(text);
    if (text === '0') {
      entered();
      return new Response('Service unavailable', { status: 503 });
    }
    await pending;
    return Response.json({ embeddings: [{ values: [Number(text)] }] });
  };
  try {
    let settled = false;
    const result = new GeminiEmbeddings('test-key').embedDocuments(['0', '1', '2'], {
      saveCheckpoint: async (value) => { saved = value; },
    }).then(() => { settled = true; }, (error) => { settled = true; return error; });
    await started;
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(settled, false);
    release();
    assert.match((await result).message, /503/);
    assert.deepEqual(requests, ['0', '1']);
    assert.deepEqual(JSON.parse(JSON.stringify(saved.vectors)), [null, [1], null]);
    requests.length = 0;
    const vectors = await new GeminiEmbeddings('test-key').embedDocuments(['0', '1', '2'], {
      checkpoint: saved, saveCheckpoint: async (value) => { saved = value; },
    }).catch((error) => error);
    assert.match(vectors.message, /503/);
    assert.ok(!requests.includes('1'), 'the successful in-flight batch must be reused after failure');
  } finally {
    release();
    globalThis.fetch = previousFetch;
  }
});

test('parallel checkpoint writes are serialized and the last snapshot contains every successful vector', async () => {
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, {
    GEMINI_EMBEDDING_DIMENSIONS: '1', GEMINI_EMBEDDING_BATCH_SIZE: '1', GEMINI_EMBEDDING_BATCH_CONCURRENCY: '3',
  });
  let activeWrites = 0;
  let maximumWrites = 0;
  const snapshots = [];
  globalThis.fetch = async (_url, options) => {
    const value = Number(JSON.parse(options.body).requests[0].content.parts[0].text.slice('title: none | text: '.length));
    await new Promise((resolve) => setTimeout(resolve, value === 0 ? 10 : 1));
    return Response.json({ embeddings: [{ values: [value] }] });
  };
  try {
    const vectors = await new GeminiEmbeddings('test-key').embedDocuments(['0', '1', '2', '3'], {
      saveCheckpoint: async (value) => {
        maximumWrites = Math.max(maximumWrites, ++activeWrites);
        await new Promise((resolve) => setTimeout(resolve, 2));
        snapshots.push(value);
        activeWrites--;
      },
    });
    assert.equal(maximumWrites, 1);
    assert.equal(snapshots.length, 4);
    assert.deepEqual(snapshots.at(-1).vectors, vectors);
    assert.equal(snapshots[0].vectors.filter((vector) => vector !== null).length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(vectors)), [[0], [1], [2], [3]]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('embedding checkpoint write errors fail the batch instead of continuing without persistence', async () => {
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, {
    GEMINI_EMBEDDING_DIMENSIONS: '1', GEMINI_EMBEDDING_BATCH_SIZE: '1', GEMINI_EMBEDDING_BATCH_CONCURRENCY: '1',
  });
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return Response.json({ embeddings: [{ values: [1] }] });
  };
  try {
    await assert.rejects(new GeminiEmbeddings('test-key').embedDocuments(['0', '1'], {
      saveCheckpoint: async () => { throw new Error('Checkpoint disk is full'); },
    }), /Checkpoint disk is full/);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

for (const reason of ['model', 'dimensions', 'inputs', 'input order', 'hash', 'vector count', 'vector dimensions', 'non-finite values']) {
  test(`embedding checkpoints are invalidated for changed ${reason}`, async () => {
    const previousFetch = globalThis.fetch;
    Object.assign(process.env, { GEMINI_EMBEDDING_DIMENSIONS: '1', GEMINI_EMBEDDING_BATCH_SIZE: '2' });
    let requests = 0;
    globalThis.fetch = async (_url, options) => {
      requests++;
      const batch = JSON.parse(options.body).requests;
      return Response.json({ embeddings: batch.map(() => ({ values: Array(Number(process.env.GEMINI_EMBEDDING_DIMENSIONS)).fill(1) })) });
    };
    let saved;
    const saveCheckpoint = async (value) => { saved = value; };
    try {
      await new GeminiEmbeddings('test-key').embedDocuments(['a', 'b'], { saveCheckpoint });
      const invalid = structuredClone(saved);
      let texts = ['a', 'b'];
      if (reason === 'model') process.env.GEMINI_EMBEDDING_MODEL = 'changed-model';
      if (reason === 'dimensions') process.env.GEMINI_EMBEDDING_DIMENSIONS = '2';
      if (reason === 'inputs') texts = ['a', 'changed'];
      if (reason === 'input order') texts = ['b', 'a'];
      if (reason === 'hash') invalid.inputHash = 'old-prompt-hash';
      if (reason === 'vector count') invalid.vectors.pop();
      if (reason === 'vector dimensions') invalid.vectors[0] = [1, 2];
      if (reason === 'non-finite values') invalid.vectors[0] = [NaN];
      const result = await new GeminiEmbeddings('test-key').embedDocuments(texts, { checkpoint: invalid, saveCheckpoint });
      assert.equal(requests, 2, 'mismatched data must not bypass Gemini');
      assert.equal(result.length, 2);
      assert.deepEqual(saved.vectors, result);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
}

test('invalid provider vector values are never persisted in an embedding checkpoint', async () => {
  const previousFetch = globalThis.fetch;
  process.env.GEMINI_EMBEDDING_DIMENSIONS = '1';
  globalThis.fetch = async () => Response.json({ embeddings: [{ values: [null] }] });
  let saved = false;
  try {
    await assert.rejects(new GeminiEmbeddings('test-key').embedDocuments(['a'], {
      saveCheckpoint: async () => { saved = true; },
    }), /invalid embeddings/);
    assert.equal(saved, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
function embeddingResponse(count) {
  return new Response(JSON.stringify({
    embeddings: Array.from({ length: count }, () => ({ values: Array(768).fill(0.1) })),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function recordingLimiter(waits = []) {
  const costs = [];
  return {
    costs,
    async tryAcquire(cost) {
      costs.push(cost);
      return waits.shift() ?? 0;
    },
  };
}

async function withFetch(handler, run) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test('memory rate limiter enforces a cost-weighted 60 second sliding window', async () => {
  let now = 0;
  const limiter = new MemorySlidingWindowRateLimiter(100, () => now);
  assert.equal(await limiter.tryAcquire(60), 0);
  now = 10_000;
  assert.equal(await limiter.tryAcquire(40), 0);
  now = 20_000;
  assert.equal(await limiter.tryAcquire(1), 40_000);
  assert.equal(await limiter.tryAcquire(50), 40_000);
  assert.equal(await limiter.tryAcquire(70), 50_000);
  now = 60_000;
  assert.equal(await limiter.tryAcquire(60), 0);
  assert.equal(await limiter.tryAcquire(1), 10_000);
});

test.each([
  ['input', '40', [40, 40, 20], [40, 40, 20]],
  ['request', '40', [1], [100]],
])('Gemini embeddings charge the limiter per %s', async (unit, limit, expectedCosts, expectedBatchSizes) => {
  process.env.GEMINI_EMBEDDING_RATE_LIMIT_PER_MINUTE = limit;
  process.env.GEMINI_EMBEDDING_RATE_LIMIT_UNIT = unit;
  process.env.GEMINI_EMBEDDING_BATCH_CONCURRENCY = '1';
  const limiter = recordingLimiter();
  const batchSizes = [];
  await withFetch(async (_url, options) => {
    const count = JSON.parse(options.body).requests.length;
    batchSizes.push(count);
    return embeddingResponse(count);
  }, async () => {
    const vectors = await new GeminiEmbeddings('test-only-key', { rateLimiter: limiter })
      .embedDocuments(Array.from({ length: 100 }, (_, index) => `chunk ${index}`));
    assert.equal(vectors.length, 100);
  });
  assert.deepEqual(batchSizes, expectedBatchSizes);
  assert.deepEqual(limiter.costs, expectedCosts);
});

test('Gemini embeddings wait for the limiter and charge every retry attempt', async () => {
  process.env.GEMINI_EMBEDDING_RATE_LIMIT_PER_MINUTE = '100';
  const limiter = recordingLimiter([5, 0, 0]);
  let calls = 0;
  const started = Date.now();
  await withFetch(async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('', { status: 503, headers: { 'Retry-After': '0.01' } });
    }
    return embeddingResponse(1);
  }, async () => {
    const vector = await new GeminiEmbeddings('test-only-key', { rateLimiter: limiter }).embedQuery('question');
    assert.equal(vector.length, 768);
  });
  assert.equal(calls, 2);
  assert.deepEqual(limiter.costs, [1, 1, 1]);
  assert.ok(Date.now() - started >= 5);
});

test('rate limiter falls back to the in-process window when Redis fails', async () => {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const limiter = new FallbackRateLimiter(
      { tryAcquire: async () => { throw new Error('Redis unavailable'); } },
      new MemorySlidingWindowRateLimiter(2),
    );
    assert.equal(await limiter.tryAcquire(2), 0);
    assert.ok(await limiter.tryAcquire(1) > 0);
  } finally {
    console.warn = warn;
  }
});

test('Gemini embeddings charge one unit per request by default', async () => {
  process.env.GEMINI_EMBEDDING_RATE_LIMIT_PER_MINUTE = '100';
  delete process.env.GEMINI_EMBEDDING_RATE_LIMIT_UNIT;
  process.env.GEMINI_EMBEDDING_BATCH_CONCURRENCY = '1';
  const limiter = recordingLimiter();
  const batchSizes = [];
  await withFetch(async (_url, options) => {
    const count = JSON.parse(options.body).requests.length;
    batchSizes.push(count);
    return embeddingResponse(count);
  }, async () => {
    const vectors = await new GeminiEmbeddings('test-only-key', { rateLimiter: limiter })
      .embedDocuments(Array.from({ length: 250 }, (_, index) => `chunk ${index}`));
    assert.equal(vectors.length, 250);
  });
  assert.deepEqual(batchSizes, [100, 100, 50]);
  assert.deepEqual(limiter.costs, [1, 1, 1]);
});

test('invalid rate limit unit is rejected', () => {
  process.env.GEMINI_EMBEDDING_RATE_LIMIT_UNIT = 'tokens';
  assert.throws(() => new GeminiEmbeddings('test-only-key'), ServiceUnavailableException);
});

const redisUrl = process.env.RATE_LIMITER_TEST_REDIS_URL;
(redisUrl ? test : test.skip)('Redis rate limiter shares one sliding window across clients', async () => {
  const key = `magnify:test:rate:${Date.now()}`;
  const first = new Redis(redisUrl);
  const second = new Redis(redisUrl);
  try {
    const a = new RedisSlidingWindowRateLimiter(first, key, 3);
    const b = new RedisSlidingWindowRateLimiter(second, key, 3);
    assert.equal(await a.tryAcquire(2), 0);
    const wait = await b.tryAcquire(2);
    assert.ok(wait > 59_000 && wait <= 60_000, `unexpected wait ${wait}`);
    assert.equal(await b.tryAcquire(1), 0);
    assert.ok(await a.tryAcquire(1) > 0);
  } finally {
    await first.del(key);
    first.disconnect();
    second.disconnect();
  }
});
