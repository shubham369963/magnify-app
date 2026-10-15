export function projectSearchFilter(ownerId: string, projectId: string) {
  return {
    must: [
      { key: 'metadata.project_id', match: { value: projectId } },
      { key: 'metadata.owner_clerk_id', match: { value: ownerId } },
    ],
  };
}

export function filterRelevantDocuments<T>(documents: Array<[T, number]>, minimumScore: number): T[] {
  return documents
    .filter(([, score]) => score >= minimumScore)
    .map(([document]) => document);
}

export function parseRelevantDocumentIndexes(response: string, candidateCount: number): number[] | null {
  const firstBrace = response.indexOf('{');
  const lastBrace = response.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;

  try {
    const parsed = JSON.parse(response.slice(firstBrace, lastBrace + 1)) as { relevant_ids?: unknown };
    if (!Array.isArray(parsed.relevant_ids)) return null;

    return [...new Set(parsed.relevant_ids.flatMap((id) => {
      if (typeof id !== 'string') return [];
      const match = id.match(/^D(\d+)$/);
      const index = match ? Number(match[1]) - 1 : -1;
      return Number.isInteger(index) && index >= 0 && index < candidateCount ? [index] : [];
    }))];
  } catch {
    return null;
  }
}

const queryStopWords = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'because', 'been', 'being', 'by', 'calculate', 'can', 'compare', 'could', 'describe', 'did', 'do', 'does', 'explain', 'for', 'from', 'give', 'had', 'has', 'have', 'how', 'identify', 'in', 'is', 'it', 'list', 'may', 'might', 'must', 'of', 'on', 'or', 'shall', 'should', 'show', 'summarize', 'tell', 'the', 'to', 'was', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would']);

function queryTerms(query: string): string[] {
  return [...new Set((query.toLocaleLowerCase().normalize('NFKC').match(/[\p{L}\p{N}][\p{L}\p{N}_+-]*/gu) ?? [])
    .map((term) => term.replace(/-/gu, '')))]
    .filter((term) => !queryStopWords.has(term));
}

export interface RankedIndexTreeCandidate {
  index: number;
  score: number;
  matchedTerms: string[];
  queryTermCount: number;
  phraseMatch: boolean;
}

export function scoreIndexTreeCandidates(
  query: string,
  candidates: Array<Record<string, unknown>>,
): RankedIndexTreeCandidate[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const normalizedQuery = query.trim().toLocaleLowerCase().normalize('NFKC').replace(/\s+/gu, ' ');
  return candidates.map((candidate, index) => {
    let score = 0;
    let phraseMatch = false;
    const matchedTerms = new Set<string>();
    for (const [key, value] of Object.entries(candidate)) {
      if (typeof value !== 'string') continue;
      const text = value.toLocaleLowerCase().normalize('NFKC').replace(/\s+/gu, ' ');
      const textTerms = new Set(queryTerms(text));
      const weight = /title|heading|section/i.test(key) ? 4
        : /summary/i.test(key) ? 2
          : /content/i.test(key) ? 1
            : /^source$/i.test(key) ? 0.25
              : 0;
      if (!weight) continue;
      if (normalizedQuery && text.includes(normalizedQuery)) {
        score += weight * 6;
        phraseMatch = true;
      }
      for (const term of terms) {
        if (!textTerms.has(term)) continue;
        matchedTerms.add(term);
        score += weight;
      }
    }
    score += (matchedTerms.size / terms.length) * 2;
    return { index, score, matchedTerms: [...matchedTerms], queryTermCount: terms.length, phraseMatch };
  })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.matchedTerms.length - left.matchedTerms.length || left.index - right.index);
}

export function rankIndexTreeCandidates(
  query: string,
  candidates: Array<Record<string, unknown>>,
  maximumSelections: number,
): number[] {
  if (maximumSelections <= 0) return [];
  return scoreIndexTreeCandidates(query, candidates)
    .slice(0, maximumSelections)
    .map(({ index }) => index);
}

export function selectDistributedFallbackIndexes(candidateCount: number, maximumSelections: number): number[] {
  if (candidateCount <= 0 || maximumSelections <= 0) return [];
  const selectionCount = Math.min(candidateCount, maximumSelections);
  return Array.from({ length: selectionCount }, (_unused, index) =>
    Math.min(candidateCount - 1, Math.floor(((index + 0.5) * candidateCount) / selectionCount)),
  );
}

export function coversIndexTreeQuery(query: string, candidates: Array<Record<string, unknown>>): boolean {
  const terms = queryTerms(query);
  if (!terms.length) return false;
  const availableTerms = new Set(candidates.flatMap((candidate) =>
    Object.values(candidate).flatMap((value) => typeof value === 'string' ? queryTerms(value) : []),
  ));
  return terms.every((term) => availableTerms.has(term));
}

export function mergeIndexTreeSelections(
  modelSelections: number[],
  rankedSelections: number[],
  maximumSelections: number,
): number[] {
  const merged: number[] = [];
  for (const index of [...modelSelections, ...rankedSelections]) {
    if (!merged.includes(index)) merged.push(index);
    if (merged.length >= maximumSelections) break;
  }
  return merged;
}

export function selectIndexTreeCandidateIndexes(
  scoredCandidates: RankedIndexTreeCandidate[],
  candidateCount: number,
  maximumCandidates: number,
): number[] {
  if (candidateCount <= 0 || maximumCandidates <= 0) return [];
  const limit = Math.min(candidateCount, maximumCandidates);
  if (!scoredCandidates.length) return selectDistributedFallbackIndexes(candidateCount, limit);

  const explorationCount = Math.min(limit, Math.max(1, Math.ceil(limit / 4)));
  const lexicalCount = Math.max(0, limit - explorationCount);
  const selected = scoredCandidates.slice(0, lexicalCount).map(({ index }) => index);
  const included = new Set(selected);
  const explorationIndexes = selectDistributedFallbackIndexes(
    candidateCount,
    Math.min(candidateCount, explorationCount * 2),
  );
  for (const index of explorationIndexes) {
    if (selected.length >= limit) break;
    if (!included.has(index)) {
      included.add(index);
      selected.push(index);
    }
  }
  for (const { index } of scoredCandidates) {
    if (selected.length >= limit) break;
    if (!included.has(index)) {
      included.add(index);
      selected.push(index);
    }
  }
  for (let index = 0; selected.length < limit && index < candidateCount; index += 1) {
    if (!included.has(index)) {
      included.add(index);
      selected.push(index);
    }
  }
  return selected;
}

export function selectIndexTreeFallbackIndexes(
  scoredCandidates: RankedIndexTreeCandidate[],
  candidateCount: number,
  maximumSelections: number,
): number[] {
  if (candidateCount <= 0 || maximumSelections <= 0) return [];
  const ranked = scoredCandidates.slice(0, maximumSelections).map(({ index }) => index);
  const bestMatch = scoredCandidates[0];
  const hasStrongLexicalMatch = Boolean(bestMatch && (bestMatch.phraseMatch
    || bestMatch.matchedTerms.length / bestMatch.queryTermCount >= 0.5));
  if (hasStrongLexicalMatch) return ranked;

  return mergeIndexTreeSelections(
    ranked.slice(0, Math.min(2, maximumSelections)),
    selectDistributedFallbackIndexes(candidateCount, maximumSelections),
    maximumSelections,
  );
}

export interface LinkedTreeEvidence {
  id: string;
  content: string;
  document_id?: string;
  source_order?: number;
  previous_evidence_id?: string;
  next_evidence_id?: string;
  continues_from_previous?: boolean;
  continues_to_next?: boolean;
}

export interface DeduplicableTreeEvidence extends LinkedTreeEvidence {
  document_id: string;
  page: number;
  content_type: string;
  section_title: string;
  original_content?: string;
  duplicate_evidence_ids?: string[];
  section_titles?: string[];
}

function normalizedEvidenceContent(content: string): string {
  return content.toLocaleLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function substantiallyOverlaps(left: string, right: string): boolean {
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (shorter.length >= 120 && longer.includes(shorter)) return true;
  return false;
}

export function deduplicateTreeEvidence<T extends DeduplicableTreeEvidence>(
  candidates: T[],
): Array<T & { duplicate_evidence_ids: string[]; section_titles: string[] }> {
  const result: Array<T & { duplicate_evidence_ids: string[]; section_titles: string[] }> = [];
  const byLocation = new Map<string, typeof result>();

  for (const candidate of candidates) {
    const location = `${candidate.document_id}\0${candidate.page}\0${candidate.content_type}`;
    const group = byLocation.get(location) ?? [];
    const normalized = normalizedEvidenceContent(candidate.content);
    const duplicate = group.find((item) => substantiallyOverlaps(
      normalized,
      normalizedEvidenceContent(item.content),
    ));
    if (!duplicate) {
      const item = {
        ...candidate,
        duplicate_evidence_ids: [...(candidate.duplicate_evidence_ids ?? [])],
        section_titles: [...new Set(candidate.section_titles ?? [candidate.section_title])],
      };
      result.push(item);
      group.push(item);
      byLocation.set(location, group);
      continue;
    }

    duplicate.duplicate_evidence_ids = [...new Set([
      ...duplicate.duplicate_evidence_ids,
      ...candidate.duplicate_evidence_ids ?? [],
      candidate.id,
    ])].filter((id) => id !== duplicate.id);
    duplicate.section_titles = [...new Set([
      ...duplicate.section_titles,
      candidate.section_title,
      ...candidate.section_titles ?? [],
    ])];
    if (candidate.content.length > duplicate.content.length) {
      duplicate.content = candidate.content;
      duplicate.original_content = candidate.original_content;
    }
  }

  return result;
}

export function expandIncompleteTreeEvidence<T extends LinkedTreeEvidence>(
  selected: T[],
  candidates: T[],
  maximumAdditional: number,
): T[] {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const result = [...selected];
  const included = new Set(result.map((item) => item.id));
  const incompleteEnding = /(?:\.\.\.|…|[,;:]|\b(?:and|or|of|to|with|for|are|is|into|by|because|while|that|which|remaining))\s*$/i;
  const incompleteBeginning = /^(?:\.\.\.|…|[,;]|(?:and|or|of|to|with|for|into|by|because|while|that|which)\b)/i;

  for (const evidence of selected) {
    if (result.length - selected.length >= maximumAdditional) break;
    const adjacentId = evidence.continues_to_next
      ? evidence.next_evidence_id
      : evidence.continues_from_previous
        ? evidence.previous_evidence_id
        : incompleteEnding.test(evidence.content.trim())
          ? evidence.next_evidence_id
          : incompleteBeginning.test(evidence.content.trim())
            ? evidence.previous_evidence_id
            : undefined;
    const adjacent = adjacentId ? byId.get(adjacentId) : undefined;
    const sameDocument = evidence.document_id && evidence.document_id === adjacent?.document_id;
    const adjacentOrder = evidence.source_order !== undefined
      && adjacent?.source_order !== undefined
      && Math.abs(evidence.source_order - adjacent.source_order) === 1;
    if (adjacent && sameDocument && adjacentOrder && !included.has(adjacent.id)) {
      included.add(adjacent.id);
      result.push(adjacent);
    }
  }
  return result;
}