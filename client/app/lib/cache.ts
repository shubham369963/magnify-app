import { backendGraphqlRequest, type TokenGetter } from "./client";

interface CachedQuery {
  request: Promise<unknown>;
  tags: Set<string>;
  data?: unknown;
  hasData: boolean;
  fetchedAt?: number;
}

const queryCache = new Map<string, CachedQuery>();
const MAX_CACHED_QUERIES = 200;
const CACHE_TTL_MS = 15_000;

function graphqlCacheKey(
  cacheScope: string,
  query: string,
  variables: Record<string, unknown>,
  timeoutMs?: number,
) {
  return JSON.stringify([cacheScope, query, variables, timeoutMs]);
}

export function invalidateGraphqlCache(tags: readonly string[]) {
  if (!tags.length) return;
  const invalidated = new Set(tags);
  for (const [key, entry] of queryCache) {
    if ([...entry.tags].some((tag) => invalidated.has(tag))) queryCache.delete(key);
  }
}

export function invalidateAllGraphqlCache() {
  queryCache.clear();
}

export function getCachedGraphqlResult<T>(
  cacheScope: string,
  query: string,
  variables: Record<string, unknown>,
  timeoutMs?: number,
): T | undefined {
  const key = graphqlCacheKey(cacheScope, query, variables, timeoutMs);
  const entry = queryCache.get(key);
  if (entry?.fetchedAt !== undefined && Date.now() - entry.fetchedAt >= CACHE_TTL_MS) {
    queryCache.delete(key);
    return undefined;
  }
  return entry?.hasData ? entry.data as T : undefined;
}

export async function cachedBackendGraphqlRequest<T>(
  getToken: TokenGetter,
  query: string,
  variables: Record<string, unknown>,
  cacheScope: string,
  timeoutMs?: number,
  cacheTags: readonly string[] = [],
): Promise<T> {
  const key = graphqlCacheKey(cacheScope, query, variables, timeoutMs);
  const existing = queryCache.get(key);
  if (existing?.fetchedAt !== undefined && Date.now() - existing.fetchedAt >= CACHE_TTL_MS) {
    queryCache.delete(key);
  } else if (existing) {
    for (const tag of cacheTags) existing.tags.add(tag);
    queryCache.delete(key);
    queryCache.set(key, existing);
    return existing.request as Promise<T>;
  }

  const signal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  const entry: CachedQuery = {
    request: Promise.resolve(undefined),
    tags: new Set(cacheTags),
    hasData: false,
  };
  const request = backendGraphqlRequest<T>(getToken, query, variables, signal).then((data) => {
    if (queryCache.get(key) === entry) {
      entry.data = data;
      entry.hasData = true;
      entry.fetchedAt = Date.now();
    }
    return data;
  }).catch((cause: unknown) => {
    if (queryCache.get(key)?.request === request) queryCache.delete(key);
    throw cause;
  });
  entry.request = request;
  queryCache.set(key, entry);
  while (queryCache.size > MAX_CACHED_QUERIES) {
    const oldestKey = queryCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    queryCache.delete(oldestKey);
  }
  return request;
}