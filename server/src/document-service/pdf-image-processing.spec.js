import assert from 'node:assert/strict';
import { afterEach, jest, test } from '@jest/globals';
import { PdfImageProcessor } from '../../dist/document-service/pdf-image-processing.js';
import { getTraceContext, runWithTraceContext } from '../../dist/observability/trace-context.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
afterEach(() => jest.useRealTimers());

test('100 image pages process at least three times faster than the serial simulated baseline', async () => {
  jest.useFakeTimers();
  const processor = new PdfImageProcessor(4, 2);
  const pages = Array.from({ length: 100 }, (_, index) => index + 1);
  const start = Date.now();
  let renderActive = 0;
  let renderPeak = 0;
  let imageActive = 0;
  let imagePeak = 0;
  let captionActive = 0;
  let captionPeak = 0;
  const resultPromise = processor.process(pages, async (page) => {
    imagePeak = Math.max(imagePeak, ++imageActive);
    renderPeak = Math.max(renderPeak, ++renderActive);
    await delay(20);
    renderActive -= 1;
    return Buffer.from(String(page));
  }, async (image) => {
    captionPeak = Math.max(captionPeak, ++captionActive);
    await delay(30);
    captionActive -= 1;
    imageActive -= 1;
    return `Caption ${image}`;
  });
  await jest.runAllTimersAsync();
  const results = await resultPromise;
  assert.deepEqual(results, pages.map((pageNumber) => ({ pageNumber, caption: `Caption ${pageNumber}` })));
  assert.equal(renderPeak, 2);
  assert.equal(imagePeak, 4);
  assert.ok(captionPeak > 1);
  const elapsed = Date.now() - start;
  assert.ok(elapsed <= (100 * 50) / 3, `Simulated concurrent time ${elapsed}ms exceeded the threefold speedup budget`);
});

test('image and render limits are shared across concurrent document jobs', async () => {
  jest.useFakeTimers();
  const processor = new PdfImageProcessor(4, 2);
  let renders = 0;
  let images = 0;
  let renderPeak = 0;
  let imagePeak = 0;
  const render = async (page) => {
    assert.equal(getTraceContext().documentId, page <= 6 ? 'first' : 'second');
    renderPeak = Math.max(renderPeak, ++renders);
    imagePeak = Math.max(imagePeak, ++images);
    await delay(10);
    renders -= 1;
    return Buffer.from(String(page));
  };
  const caption = async (image) => {
    assert.equal(getTraceContext().documentId, Number(String(image)) <= 6 ? 'first' : 'second');
    await delay(30);
    images -= 1;
    return String(image);
  };
  const first = runWithTraceContext({ documentId: 'first' }, () =>
    processor.process([1, 2, 3, 4, 5, 6], render, caption));
  const second = runWithTraceContext({ documentId: 'second' }, () =>
    processor.process([7, 8, 9, 10, 11, 12], render, caption));
  await jest.runAllTimersAsync();
  const results = await Promise.all([first, second]);
  assert.equal(renderPeak, 2);
  assert.equal(imagePeak, 4);
  assert.equal(results.flat().length, 12);
});

test('out-of-order captions retain page ordering and serialize monotonic progress writes', async () => {
  jest.useFakeTimers();
  const processor = new PdfImageProcessor(4, 2);
  const finished = [];
  const progress = [];
  let writing = false;
  const promise = processor.process([1, 2, 3, 4], async (page) => Buffer.from(String(page)), async (image) => {
    const page = Number(String(image));
    await delay((5 - page) * 10);
    finished.push(page);
    return `Page ${page}`;
  }, async (completed) => {
    assert.equal(writing, false);
    writing = true;
    await delay(completed === 1 ? 50 : 1);
    progress.push(completed);
    writing = false;
  });
  await jest.runAllTimersAsync();
  const results = await promise;
  assert.deepEqual(finished, [4, 3, 2, 1]);
  assert.deepEqual(results.map((result) => result.pageNumber), [1, 2, 3, 4]);
  assert.deepEqual(progress, [1, 2, 3, 4]);
});

test('failure stops new pages, drains in-flight captions, and releases shared slots', async () => {
  const processor = new PdfImageProcessor(2, 2);
  const secondStarted = deferred();
  const failureStarted = deferred();
  const releaseSecond = deferred();
  const rendered = [];
  const failure = new Error('Vision quota exceeded');
  let settled = false;
  const outcome = processor.process([1, 2, 3, 4], async (page) => {
    rendered.push(page);
    return Buffer.from(String(page));
  }, async (image) => {
    if (String(image) === '1') {
      await secondStarted.promise;
      failureStarted.resolve();
      throw failure;
    }
    secondStarted.resolve();
    await releaseSecond.promise;
    return 'Second page';
  }).then(() => { settled = true; return null; }, (error) => { settled = true; return error; });
  await failureStarted.promise;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(rendered, [1, 2]);
  releaseSecond.resolve();
  assert.equal(await outcome, failure);
  assert.deepEqual(await processor.process([5], async () => Buffer.from('5'), async () => 'Recovered'), [
    { pageNumber: 5, caption: 'Recovered' },
  ]);
});

test('render and progress failures propagate without leaking concurrency slots', async () => {
  const processor = new PdfImageProcessor(2, 1);
  const error = new Error('Render failed');
  await assert.rejects(processor.process([1, 2, 3], async () => { throw error; }, async () => 'unused'), (value) => value === error);
  await assert.rejects(processor.process([4], async () => Buffer.from('4'), async () => 'caption', async () => {
    throw new Error('Progress write failed');
  }), /Progress write failed/);
  assert.deepEqual(await processor.process([], async () => { throw error; }, async () => { throw error; }), []);
  assert.deepEqual(await processor.process([5], async () => Buffer.from('5'), async () => ''), [{ pageNumber: 5, caption: '' }]);
});

test('invalid processor limits fail instead of silently omitting image pages', () => {
  assert.throws(() => new PdfImageProcessor(0, 1), /positive integer/);
  assert.throws(() => new PdfImageProcessor(2, 0), /positive integer/);
});
