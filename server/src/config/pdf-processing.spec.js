import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from '@jest/globals';
import { readPdfProcessingSettings } from '../../dist/config/pdf-processing.js';

const keys = ['PDF_WORKER_CONCURRENCY', 'PDF_IMAGE_CONCURRENCY', 'PDF_RENDER_CONCURRENCY',
  'PDF_IMAGE_MIN_WIDTH', 'PDF_IMAGE_MIN_HEIGHT', 'PDF_IMAGE_MIN_DISPLAY_POINTS', 'PDF_IMAGE_MAX_REPEAT_PAGES'];
const concurrencyKeys = keys.slice(0, 3);
let previous;
beforeEach(() => {
  previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  keys.forEach((key) => delete process.env[key]);
});
afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const defaultImageFilter = { minWidth: 150, minHeight: 150, minDisplayPoints: 72, maxRepeatPages: 3 };

test('PDF concurrency defaults bound work without changing the number of job slots', () => {
  assert.deepEqual(readPdfProcessingSettings(), {
    workerConcurrency: 4, imageConcurrency: 4, renderConcurrency: 2, imageFilter: defaultImageFilter,
  });
});

test('PDF concurrency settings accept explicit overrides', () => {
  Object.assign(process.env, { PDF_WORKER_CONCURRENCY: '8', PDF_IMAGE_CONCURRENCY: '6', PDF_RENDER_CONCURRENCY: '1' });
  assert.deepEqual(readPdfProcessingSettings(), {
    workerConcurrency: 8, imageConcurrency: 6, renderConcurrency: 1, imageFilter: defaultImageFilter,
  });
});

test('invalid concurrency fails explicitly instead of disabling or unbounding processing', () => {
  for (const key of concurrencyKeys) {
    for (const value of ['', '0', '-1', '1.5', 'NaN', '33']) {
      process.env[key] = value;
      assert.throws(() => readPdfProcessingSettings(), new RegExp(key));
    }
    delete process.env[key];
  }
});

test('image filter thresholds accept overrides, allow 0 to disable, and reject invalid values', () => {
  Object.assign(process.env, {
    PDF_IMAGE_MIN_WIDTH: '0', PDF_IMAGE_MIN_HEIGHT: '200', PDF_IMAGE_MIN_DISPLAY_POINTS: '0', PDF_IMAGE_MAX_REPEAT_PAGES: '5',
  });
  assert.deepEqual(readPdfProcessingSettings().imageFilter, { minWidth: 0, minHeight: 200, minDisplayPoints: 0, maxRepeatPages: 5 });
  for (const key of keys.slice(3)) {
    for (const value of ['', '-1', '1.5', 'NaN', '100000']) {
      process.env[key] = value;
      assert.throws(() => readPdfProcessingSettings(), new RegExp(key));
    }
    process.env[key] = '0';
  }
});
