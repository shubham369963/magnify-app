import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { redisConnection } from './settings.js';

export const RATE_LIMIT_WINDOW_MS = 60_000;

/** Returns 0 once `cost` units are reserved, otherwise the milliseconds to wait before trying again. */
export interface EmbeddingRateLimiter {
  tryAcquire(cost: number): Promise<number>;
}

export class MemorySlidingWindowRateLimiter implements EmbeddingRateLimiter {
  private readonly entries: Array<{ at: number; cost: number }> = [];

  constructor(
    private readonly limit: number,
    private readonly now: () => number = Date.now,
    private readonly windowMs = RATE_LIMIT_WINDOW_MS,
  ) {}

  async tryAcquire(cost: number): Promise<number> {
    const now = this.now();
    while (this.entries.length && this.entries[0].at <= now - this.windowMs) this.entries.shift();
    const used = this.entries.reduce((total, entry) => total + entry.cost, 0);
    if (used + cost <= this.limit) {
      this.entries.push({ at: now, cost });
      return 0;
    }
    let needed = used + cost - this.limit;
    for (const entry of this.entries) {
      needed -= entry.cost;
      if (needed <= 0) return Math.max(1, entry.at + this.windowMs - now);
    }
    return this.windowMs;
  }
}

// Cost-weighted sliding window; uses Redis server time so API and worker processes share one clock.
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local entries = redis.call('ZRANGE', key, 0, -1, 'WITHSCORES')
local used = 0
for i = 1, #entries, 2 do
  used = used + tonumber(string.match(entries[i], '^(%d+):'))
end
if used + cost <= limit then
  redis.call('ZADD', key, now, cost .. ':' .. ARGV[4])
  redis.call('PEXPIRE', key, window)
  return 0
end
local needed = used + cost - limit
for i = 1, #entries, 2 do
  needed = needed - tonumber(string.match(entries[i], '^(%d+):'))
  if needed <= 0 then
    return math.max(1, tonumber(entries[i + 1]) + window - now)
  end
end
return window
`;

export class RedisSlidingWindowRateLimiter implements EmbeddingRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly key: string,
    private readonly limit: number,
    private readonly windowMs = RATE_LIMIT_WINDOW_MS,
  ) {}

  async tryAcquire(cost: number): Promise<number> {
    const waitMs = await this.redis.eval(
      SLIDING_WINDOW_SCRIPT, 1, this.key, this.limit, cost, this.windowMs, randomUUID(),
    );
    return Number(waitMs);
  }
}

/** Prefers the shared Redis window; falls back to a per-process window while Redis is unreachable. */
export class FallbackRateLimiter implements EmbeddingRateLimiter {
  private lastWarningAt = 0;

  constructor(
    private readonly primary: EmbeddingRateLimiter,
    private readonly fallback: EmbeddingRateLimiter,
  ) {}

  async tryAcquire(cost: number): Promise<number> {
    try {
      return await this.primary.tryAcquire(cost);
    } catch (error) {
      if (Date.now() - this.lastWarningAt > RATE_LIMIT_WINDOW_MS) {
        this.lastWarningAt = Date.now();
        console.warn(JSON.stringify({
          event: 'dependency.rate_limiter_fallback',
          system: 'gemini_embeddings',
          errorName: error instanceof Error ? error.name : 'Error',
          errorMessage: error instanceof Error ? error.message : String(error),
        }));
      }
      return this.fallback.tryAcquire(cost);
    }
  }
}

const sharedLimiters = new Map<string, EmbeddingRateLimiter>();
let sharedRedis: Redis | undefined;

/** One limiter per model and limit, shared by every GeminiEmbeddings instance in the process. */
export function sharedEmbeddingRateLimiter(model: string, unit: string, limit: number): EmbeddingRateLimiter {
  const cacheKey = `${model}:${unit}:${limit}`;
  let limiter = sharedLimiters.get(cacheKey);
  if (!limiter) {
    if (!sharedRedis) {
      sharedRedis = new Redis({
        ...redisConnection(),
        lazyConnect: true,
        connectTimeout: 2_000,
        commandTimeout: 2_000,
        maxRetriesPerRequest: 1,
      });
      // Failures surface through tryAcquire, which falls back to the in-process window.
      sharedRedis.on('error', () => undefined);
    }
    limiter = new FallbackRateLimiter(
      new RedisSlidingWindowRateLimiter(sharedRedis, `magnify:gemini-embedding:rate:${model}:${unit}`, limit),
      new MemorySlidingWindowRateLimiter(limit),
    );
    sharedLimiters.set(cacheKey, limiter);
  }
  return limiter;
}
