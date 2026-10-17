import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from '@jest/globals';
import { UnauthorizedException } from '@nestjs/common';
import { ClerkWebhookController, verifyClerkWebhook } from '../../dist/auth/clerk-webhook.controller.js';

const secret = `whsec_${Buffer.from('test-webhook-secret').toString('base64')}`;

function signedEvent(event, timestamp = String(Math.floor(Date.now() / 1000))) {
  const rawBody = Buffer.from(JSON.stringify(event));
  const webhookId = 'msg_test_123';
  const signature = createHmac('sha256', Buffer.from(secret.slice('whsec_'.length), 'base64'))
    .update(Buffer.concat([Buffer.from(`${webhookId}.${timestamp}.`), rawBody]))
    .digest('base64');
  return { rawBody, webhookId, timestamp, signature: `v1,${signature}` };
}

test('Clerk webhook verifier accepts a fresh valid signature', () => {
  const event = { type: 'user.deleted', data: { id: 'user_deleted' } };
  const signed = signedEvent(event);
  assert.deepEqual(
    verifyClerkWebhook(signed.rawBody, signed.webhookId, signed.timestamp, signed.signature, secret),
    event,
  );
});

test('Clerk webhook verifier rejects invalid signatures and stale timestamps', () => {
  const signed = signedEvent({ type: 'user.deleted', data: { id: 'user_deleted' } });
  assert.throws(
    () => verifyClerkWebhook(signed.rawBody, signed.webhookId, signed.timestamp, 'v1,invalid', secret),
    UnauthorizedException,
  );
  assert.throws(
    () => verifyClerkWebhook(signed.rawBody, signed.webhookId, '1', signed.signature, secret),
    UnauthorizedException,
  );
});

test('user.deleted events invoke owner data cleanup', async () => {
  const previousSecret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  process.env.CLERK_WEBHOOK_SIGNING_SECRET = secret;
  let deletedOwner;
  const order = [];
  const controller = new ClerkWebhookController({
    deleteUserData: async (ownerId) => { deletedOwner = ownerId; order.push('data'); },
  }, {
    removeOwnerJobs: async (ownerId) => { assert.equal(ownerId, 'user_deleted'); order.push('jobs'); },
  });
  const signed = signedEvent({ type: 'user.deleted', data: { id: 'user_deleted' } });
  try {
    assert.deepEqual(await controller.receive({ rawBody: signed.rawBody }, signed.webhookId, signed.timestamp, signed.signature), { received: true });
    assert.equal(deletedOwner, 'user_deleted');
    assert.deepEqual(order, ['jobs', 'data', 'jobs']);
  } finally {
    if (previousSecret === undefined) delete process.env.CLERK_WEBHOOK_SIGNING_SECRET;
    else process.env.CLERK_WEBHOOK_SIGNING_SECRET = previousSecret;
  }
});