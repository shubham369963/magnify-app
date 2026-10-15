import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import { GeminiEmbeddings } from '../../dist/config/gemini-embeddings.js';

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
    await assert.rejects(
      () => new GeminiEmbeddings('test-only-key').embedDocuments(['rate limited']),
      /Gemini embedding request failed \(429\): .*RESOURCE_EXHAUSTED/u,
    );
    assert.equal(attempts, 3);
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