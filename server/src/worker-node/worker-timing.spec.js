import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { initialQueueWaitSeconds } from '../../dist/worker-node/worker-timing.js';

test('initial activation measures actual enqueue-to-start wait', () => {
  assert.equal(initialQueueWaitSeconds({ timestamp: 1000, processedOn: 4500, attemptsMade: 0 }), 3.5);
  assert.equal(initialQueueWaitSeconds({ timestamp: 1000, attemptsMade: 0 }, 5000), 4);
});

test('retry age and stalled recovery are not recorded as fresh queue waits', () => {
  assert.equal(initialQueueWaitSeconds({ timestamp: 1000, processedOn: 901000, attemptsMade: 1 }), undefined);
  assert.equal(initialQueueWaitSeconds({ timestamp: 1000, processedOn: 901000, attemptsMade: 0, stalledCounter: 1 }), undefined);
  assert.equal(initialQueueWaitSeconds({ timestamp: 1000, processedOn: 901000, attemptsMade: 0, attemptsStarted: 2 }), undefined);
});
