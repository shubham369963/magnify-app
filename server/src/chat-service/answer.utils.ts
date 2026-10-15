export const INSUFFICIENT_EVIDENCE_ANSWER = 'The requested information is unavailable in the provided documents.';

export interface GroundingEvidence {
  id: string;
  content: string;
  alternateIds?: string[];
  documentId?: string;
  source?: string;
  page?: number;
  sourceOrder?: number;
  contentType?: string;
  sectionTitle?: string;
}

export interface GroundedSource extends GroundingEvidence {
  excerpt: string;
  evidenceIds: string[];
}

export interface GroundedResponse {
  answer: string;
  sources: GroundedSource[];
}

interface TextWithOffsets {
  normalized: string;
  starts: number[];
  ends: number[];
}

function normalizeWithOffsets(value: string): TextWithOffsets {
  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (let offset = 0; offset < value.length;) {
    const character = String.fromCodePoint(value.codePointAt(offset)!);
    const nextOffset = offset + character.length;
    if (/\s/u.test(character)) {
      if (characters.length && characters.at(-1) !== ' ') {
        characters.push(' ');
        starts.push(offset);
        ends.push(nextOffset);
      } else if (characters.length) {
        ends[ends.length - 1] = nextOffset;
      }
    } else {
      characters.push(character);
      starts.push(offset);
      ends.push(nextOffset);
    }
    offset = nextOffset;
  }
  if (characters.at(-1) === ' ') {
    characters.pop();
    starts.pop();
    ends.pop();
  }
  return { normalized: characters.join(''), starts, ends };
}

function findVerbatimExcerpt(source: string, candidate: string): string | null {
  const sourceText = normalizeWithOffsets(source);
  const excerptText = candidate.replace(/\s+/gu, ' ').trim();
  if (!excerptText || excerptText.length > source.length) return null;
  const sourceCharacters = Array.from(sourceText.normalized);
  const excerptCharacters = Array.from(excerptText);
  let start = -1;
  for (let offset = 0; offset <= sourceCharacters.length - excerptCharacters.length; offset += 1) {
    if (excerptCharacters.every((character, index) => sourceCharacters[offset + index] === character)) {
      start = offset;
      break;
    }
  }
  if (start < 0) return null;
  const end = start + excerptCharacters.length - 1;
  return source.slice(sourceText.starts[start], sourceText.ends[end]).trim();
}

function parseResponseObject(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function cleanAnswer(answer: string): string {
  return answer
    .replace(/\[[^\]\n]{1,180},\s*p(?:age)?\.?\s*\d+\]/giu, '')
    .replace(/(?:^|\n)\s*Sources?:\s*(?:(?:\[[^\]]+\]\((?:https?:\/\/|mailto:)[^)]+\)|(?:https?:\/\/|mailto:)\S+)[^\n]*(?:\n[\s\S]*)?)$/iu, '')
    .replace(/\[[^\]]+\]\((?:https?:\/\/|mailto:)[^)]+\)/giu, '')
    .replace(/https?:\/\/\S+/giu, '')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\s+([.,;:!?])/gu, '$1')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function formatAnswerAsMarkdown(answer: string): string {
  return answer.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (/^#{1,6}\s/u.test(line)) return line;
      const content = line.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/u, '');
      const label = content.match(/^([^:*`]{1,40}):\s*(.+)$/u);
      if (!content.includes('**') && label) {
        const [, name, value] = label;
        const emphasizeValue = /^(?:cgpa|gpa|salary|score|grade|percentage|duration|period|date|year)$/iu.test(name.trim());
        return `- **${name.trim()}:** ${emphasizeValue ? `**${value.trim()}**` : value.trim()}`;
      }
      return `- ${content}`;
    })
    .join('\n');
}

export function parseGroundedResponse(raw: string, evidence: GroundingEvidence[]): GroundedResponse {
  const parsed = parseResponseObject(raw);
  if (!parsed || typeof parsed !== 'object') {
    return { answer: INSUFFICIENT_EVIDENCE_ANSWER, sources: [] };
  }
  const response = parsed as { answer?: unknown; sources?: unknown };
  if (typeof response.answer !== 'string' || !Array.isArray(response.sources)) {
    return { answer: INSUFFICIENT_EVIDENCE_ANSWER, sources: [] };
  }

  const evidenceById = new Map<string, GroundingEvidence>();
  for (const item of evidence) {
    evidenceById.set(item.id, item);
    for (const alternateId of item.alternateIds ?? []) evidenceById.set(alternateId, item);
  }

  const sourcesByEvidenceId = new Map<string, GroundedSource>();
  for (const value of response.sources) {
    if (!value || typeof value !== 'object') continue;
    const source = value as { id?: unknown; excerpt?: unknown };
    if (typeof source.id !== 'string' || typeof source.excerpt !== 'string') continue;
    const original = evidenceById.get(source.id);
    if (!original || sourcesByEvidenceId.has(original.id)) continue;
    const excerpt = findVerbatimExcerpt(original.content, source.excerpt);
    if (!excerpt) continue;
    sourcesByEvidenceId.set(original.id, {
      ...original,
      excerpt,
      evidenceIds: [original.id, ...(original.alternateIds ?? [])],
    });
  }

  const answer = cleanAnswer(response.answer);
  if (!answer || !sourcesByEvidenceId.size) {
    return { answer: INSUFFICIENT_EVIDENCE_ANSWER, sources: [] };
  }
  const sources = [...sourcesByEvidenceId.values()].sort((left, right) =>
    (left.page ?? Number.MAX_SAFE_INTEGER) - (right.page ?? Number.MAX_SAFE_INTEGER)
    || (left.source ?? '').localeCompare(right.source ?? '')
    || (left.sourceOrder ?? Number.MAX_SAFE_INTEGER) - (right.sourceOrder ?? Number.MAX_SAFE_INTEGER),
  );
  return { answer: formatAnswerAsMarkdown(answer), sources };
}