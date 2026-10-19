import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { metrics } from '../observability/metrics.js';

const COHERE_RERANK_ENDPOINT = 'https://api.cohere.com/v2/rerank';
const MAX_DOCUMENTS_PER_REQUEST = 1000;

interface CohereRerankResponse {
  results?: Array<{
    index?: unknown;
    relevance_score?: unknown;
  }>;
}

export interface RerankedCandidate {
  index: number;
  relevanceScore: number;
}

@Injectable()
export class CohereRerankerService {
  async rerank(
    query: string,
    documents: string[],
    topN: number,
    operation: string,
  ): Promise<RerankedCandidate[]> {
    if (!documents.length || topN <= 0) return [];

    const apiKey = process.env.COHERE_API_KEY;
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'Cohere reranking is not configured. Set COHERE_API_KEY to enable chat retrieval.',
      );
    }

    const model = process.env.COHERE_RERANK_MODEL || 'rerank-v4.0-pro';
    const limit = Math.min(Math.floor(topN), documents.length);
    const results: RerankedCandidate[] = [];

    for (
      let offset = 0;
      offset < documents.length;
      offset += MAX_DOCUMENTS_PER_REQUEST
    ) {
      const batch = documents.slice(
        offset,
        offset + MAX_DOCUMENTS_PER_REQUEST,
      );
      const body = JSON.stringify({
        model,
        query,
        documents: batch,
        top_n: Math.min(limit, batch.length),
      });
      const response = await metrics.trackDependency(
        'cohere_rerank',
        operation,
        async () => {
          const result = await fetch(COHERE_RERANK_ENDPOINT, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${apiKey}`,
              'content-type': 'application/json',
            },
            body,
            signal: AbortSignal.timeout(60_000),
          });
          if (!result.ok) {
            const details = (await result.text()).slice(0, 300);
            throw new Error(
              `Cohere rerank request failed (${result.status}): ${details}`,
            );
          }
          return result.json() as Promise<CohereRerankResponse>;
        },
        Buffer.byteLength(body),
        (result) => Buffer.byteLength(JSON.stringify(result)),
      );

      if (!Array.isArray(response.results)) {
        throw new Error('Cohere rerank response did not contain results.');
      }
      for (const result of response.results) {
        if (!result || typeof result !== 'object') {
          throw new Error('Cohere rerank response contained an invalid result.');
        }
        const resultIndex = result.index;
        if (
          typeof resultIndex !== 'number' ||
          !Number.isInteger(resultIndex) ||
          resultIndex < 0 ||
          resultIndex >= batch.length ||
          typeof result.relevance_score !== 'number' ||
          !Number.isFinite(result.relevance_score)
        ) {
          throw new Error('Cohere rerank response contained an invalid result.');
        }
        results.push({
          index: offset + resultIndex,
          relevanceScore: result.relevance_score,
        });
      }
    }

    return results
      .sort(
        (left, right) =>
          right.relevanceScore - left.relevanceScore ||
          left.index - right.index,
      )
      .slice(0, limit);
  }
}
