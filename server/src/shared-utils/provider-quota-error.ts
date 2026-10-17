import { UnrecoverableError } from 'bullmq';

/** A provider rejected work because a quota or rate limit was exhausted; indexing must stop without retries. */
export class ProviderQuotaError extends UnrecoverableError {
  constructor(readonly provider: string, readonly detail?: string) {
    super(`${provider} quota exceeded, so PDF indexing was stopped.`);
    this.name = 'ProviderQuotaError';
  }
}

const QUOTA_MESSAGE = /\(429\)|status(?: code)?:? 429\b|quota|resource[_ ]exhausted|too many requests|rate[ -]?limit(?:ed| exceeded| reached)/i;

function statusCode(error: object): unknown {
  if ('status_code' in error) return error.status_code;
  if ('status' in error) return error.status;
  if ('response' in error && typeof error.response === 'object' && error.response !== null && 'status' in error.response) {
    return error.response.status;
  }
  return undefined;
}

export function isProviderQuotaFailure(error: unknown): boolean {
  if (error instanceof ProviderQuotaError) return true;
  if (typeof error !== 'object' || error === null) return false;
  if (Number(statusCode(error)) === 429) return true;
  return error instanceof Error && QUOTA_MESSAGE.test(error.message);
}
