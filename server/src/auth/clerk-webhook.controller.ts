import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import type { Request } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProjectsService } from '../project-service/projects.service.js';
import { UploadService } from '../document-service/upload.service.js';

interface ClerkWebhookEvent {
  type: string;
  data: Record<string, unknown>;
}

export function verifyClerkWebhook(
  rawBody: Buffer | undefined,
  webhookId: string | undefined,
  timestamp: string | undefined,
  signature: string | undefined,
  secret: string,
  now = Date.now(),
): ClerkWebhookEvent {
  if (!rawBody) throw new BadRequestException('Webhook raw body is unavailable.');
  if (!webhookId || !timestamp || !signature) {
    throw new UnauthorizedException('Clerk webhook signature headers are required.');
  }
  if (!secret.startsWith('whsec_')) {
    throw new ServiceUnavailableException('Clerk webhook signing secret is invalid.');
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(Math.floor(now / 1000) - timestampSeconds) > 300) {
    throw new UnauthorizedException('Clerk webhook timestamp is invalid or expired.');
  }

  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  if (!key.length) throw new ServiceUnavailableException('Clerk webhook signing secret is invalid.');
  const signedPayload = Buffer.concat([Buffer.from(`${webhookId}.${timestamp}.`), rawBody]);
  const expected = createHmac('sha256', key).update(signedPayload).digest();
  const validSignature = signature.split(' ').some((versionedSignature) => {
    const [version, encodedSignature] = versionedSignature.split(',', 2);
    if (version !== 'v1' || !encodedSignature) return false;
    const candidate = Buffer.from(encodedSignature, 'base64');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
  if (!validSignature) throw new UnauthorizedException('Clerk webhook signature is invalid.');

  try {
    const event: unknown = JSON.parse(rawBody.toString('utf8'));
    if (typeof event !== 'object' || event === null || !('type' in event) || typeof event.type !== 'string'
      || !('data' in event) || typeof event.data !== 'object' || event.data === null) {
      throw new Error('Unexpected event shape.');
    }
    return event as ClerkWebhookEvent;
  } catch {
    throw new BadRequestException('Clerk webhook body is invalid.');
  }
}

@Controller('webhooks/clerk')
export class ClerkWebhookController {
  constructor(
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(UploadService) private readonly uploads: UploadService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('svix-id') webhookId?: string,
    @Headers('svix-timestamp') timestamp?: string,
    @Headers('svix-signature') signature?: string,
  ) {
    const secret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
    if (!secret) throw new ServiceUnavailableException('Clerk webhook verification is not configured.');

    const event = verifyClerkWebhook(request.rawBody, webhookId, timestamp, signature, secret);
    if (event.type === 'user.deleted') {
      const ownerId = event.data.id;
      if (typeof ownerId !== 'string' || !ownerId) {
        throw new BadRequestException('Deleted Clerk user ID is missing.');
      }
      // Drop pending jobs first so workers do not start indexing data being deleted.
      await this.uploads.removeOwnerJobs(ownerId);
      await this.projects.deleteUserData(ownerId);
      // Clear records of jobs that finished while the data was being deleted.
      await this.uploads.removeOwnerJobs(ownerId);
    }
    return { received: true };
  }
}