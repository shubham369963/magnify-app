import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from '@jest/globals';
import { DEFAULT_PAGE_TEXT_CHUNK_SIZE, splitPageText } from '../../dist/document-service/pdf-chunking.utils.js';

test('100-page PDF text chunks within the indexing performance budget', () => {
  const pages = Array.from({ length: 100 }, (_value, pageIndex) => ({
    pageNumber: pageIndex + 1,
    text: Array.from({ length: 5000 }, (_word, wordIndex) => `page${pageIndex + 1}word${wordIndex}`).join(' '),
  }));
  const startedAt = performance.now();
  let chunkCount = 0;

  for (const page of pages) {
    const chunks = splitPageText(page.text);
    chunkCount += chunks.length;
    assert.ok(chunks.every((chunk) => chunk.length <= DEFAULT_PAGE_TEXT_CHUNK_SIZE));
    assert.equal(chunks.join(' '), page.text);
  }

  const elapsedMs = performance.now() - startedAt;
  assert.ok(chunkCount > pages.length);
  assert.ok(elapsedMs < 10_000, `Chunking took ${elapsedMs.toFixed(0)} ms for a 100-page fixture`);
});