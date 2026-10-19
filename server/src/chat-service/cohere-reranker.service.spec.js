import assert from 'node:assert/strict';
import { afterEach, jest, test } from '@jest/globals';
import { CohereRerankerService } from '../../dist/chat-service/cohere-reranker.service.js';

const originalApiKey = process.env.COHERE_API_KEY;
const originalModel = process.env.COHERE_RERANK_MODEL;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.COHERE_API_KEY;
  else process.env.COHERE_API_KEY = originalApiKey;
  if (originalModel === undefined) delete process.env.COHERE_RERANK_MODEL;
  else process.env.COHERE_RERANK_MODEL = originalModel;
  jest.restoreAllMocks();
});

test('Cohere reranking combines relevance order across batches and maps candidate indexes', async () => {
  process.env.COHERE_API_KEY = 'test-key';
  process.env.COHERE_RERANK_MODEL = 'rerank-test-model';
  const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.documents.length === 1000) {
      return new Response(JSON.stringify({
        results: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.3 },
        ],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      results: [{ index: 0, relevance_score: 0.95 }],
    }), { status: 200 });
  });
  const reranker = new CohereRerankerService();

  const results = await reranker.rerank(
    'What is most relevant?',
    Array.from({ length: 1001 }, (_unused, index) => `passage ${index}`),
    2,
    'test',
  );

  assert.deepEqual(results, [
    { index: 1000, relevanceScore: 0.95 },
    { index: 1, relevanceScore: 0.9 },
  ]);
  assert.equal(fetchSpy.mock.calls.length, 2);
  const firstRequest = JSON.parse(fetchSpy.mock.calls[0][1].body);
  assert.equal(firstRequest.model, 'rerank-test-model');
  assert.equal(firstRequest.top_n, 2);
});

test('Cohere reranking reports missing credentials explicitly', async () => {
  delete process.env.COHERE_API_KEY;
  await assert.rejects(
    new CohereRerankerService().rerank('question', ['passage'], 1, 'test'),
    /COHERE_API_KEY/u,
  );
});

test('Cohere reranking surfaces provider errors', async () => {
  process.env.COHERE_API_KEY = 'test-key';
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('invalid request', { status: 429 }),
  );
  await assert.rejects(
    new CohereRerankerService().rerank('question', ['passage'], 1, 'test'),
    /Cohere rerank request failed \(429\)/u,
  );
});
