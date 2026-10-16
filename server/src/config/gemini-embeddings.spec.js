import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import { GeminiEmbeddings } from '../../dist/config/gemini-embeddings.js';

const embeddingSettings = {
  GEMINI_EMBEDDING_MODEL: 'gemini-embedding-2',
  GEMINI_EMBEDDING_DIMENSIONS: '768',
  GEMINI_EMBEDDING_BATCH_SIZE: '100',
  GEMINI_EMBEDDING_MAX_ATTEMPTS: '3',
  GEMINI_EMBEDDING_REQUEST_TIMEOUT_MS: '60000',
  GEMINI_EMBEDDING_RETRY_DELAY_MS: '250',
  GEMINI_EMBEDDING_RATE_LIMIT_RETRY_DELAY_MS: '15000',
  GEMINI_EMBEDDING_RATE_LIMIT_MAX_DELAY_MS: '60000',
  GEMINI_EMBEDDING_MAX_RETRY_AFTER_MS: '120000',
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

test('Gemini embeddings honor Retry-After when rate limited', async () => {
  const previousFetch = globalThis.fetch;
  const previousTimeout = globalThis.setTimeout;
  let attempts = 0;
  let retryDelay;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) return new Response('', { status: 429, headers: { 'Retry-After': '2' } });
    return new Response(JSON.stringify({ embeddings: [{ values: Array(768).fill(0.1) }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  globalThis.setTimeout = (callback, delay) => {
    retryDelay = delay;
    callback();
    return 0;
  };
  try {
    await new GeminiEmbeddings('test-only-key').embedDocuments(['retry after quota reset']);
    assert.equal(attempts, 2);
    assert.equal(retryDelay, 2000);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousTimeout;
  }
});

test('Gemini embedding errors include the provider reason for exhausted rate limits', async () => {
  const previousFetch = globalThis.fetch;
  const previousTimeout = globalThis.setTimeout;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response(JSON.stringify({
      error: { message: 'Quota exceeded for metric: requests per minute', status: 'RESOURCE_EXHAUSTED' },
    }), { status: 429 });
  };
  globalThis.setTimeout = (callback) => {
    callback();
    return 0;
  };
  try {
    process.env.GEMINI_EMBEDDING_MAX_ATTEMPTS = '2';
    await assert.rejects(
      () => new GeminiEmbeddings('test-only-key').embedDocuments(['rate limited']),
      /Gemini embedding request failed \(429\): .*RESOURCE_EXHAUSTED/u,
    );
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = previousFetch;
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