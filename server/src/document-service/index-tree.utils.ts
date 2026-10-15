import { createHash } from 'node:crypto';

export interface SourcePassage {
  id: string;
  sourceOrder: number;
  page: number;
  content: string;
  normalizedContent?: string;
  sectionTitle?: string;
  sectionPath?: string[];
  contentType?: 'text' | 'image_caption';
  continuesFromPrevious?: boolean;
  continuesToNext?: boolean;
}

export interface ProposedIndexSection {
  title: string;
  summary: string;
  passageIds: string[];
  children?: ProposedIndexSection[];
}

export interface ProjectIndexTreeNode {
  id: string;
  type: string;
  title: string;
  summary?: string;
  document_id?: string;
  source?: string;
  page?: number;
  content_type?: string;
  start_page?: number;
  end_page?: number;
  source_order?: number;
  content_reference?: string;
  previous_evidence_id?: string;
  next_evidence_id?: string;
  continues_from_previous?: boolean;
  continues_to_next?: boolean;
  source_document_ids?: string[];
  children?: ProjectIndexTreeNode[];
}

export interface OrderedTreeEvidence {
  id: string;
  document_id?: string;
  source_order?: number;
  previous_evidence_id?: string;
  next_evidence_id?: string;
}

export function createIndexSectionId(documentId: string, sectionIndex: number): string {
  return `section-${documentId}-${sectionIndex}`;
}

export function linkAdjacentTreeEvidence<T extends OrderedTreeEvidence>(evidence: T[]): void {
  const byDocument = new Map<string, T[]>();
  for (const item of evidence) {
    if (!item.document_id || !Number.isInteger(item.source_order)) continue;
    const documentEvidence = byDocument.get(item.document_id) ?? [];
    documentEvidence.push(item);
    byDocument.set(item.document_id, documentEvidence);
  }

  for (const documentEvidence of byDocument.values()) {
    documentEvidence.sort((left, right) => left.source_order! - right.source_order!);
    for (const [index, item] of documentEvidence.entries()) {
      item.previous_evidence_id = documentEvidence[index - 1]?.id;
      item.next_evidence_id = documentEvidence[index + 1]?.id;
    }
  }
}

export function validateProjectIndexTree(tree: ProjectIndexTreeNode, expectedDocumentIds: string[]): void {
  const fail = (message: string): never => {
    throw new Error(`Invalid project index tree: ${message}`);
  };
  const rootChildren = tree.children;
  if (tree.type !== 'root' || !tree.id || !Array.isArray(rootChildren)) fail('missing root or document branches');

  const expected = new Set(expectedDocumentIds);
  const nodeIds = new Set<string>();
  const registerNodeId = (id: string | undefined, kind: string) => {
    const stableId = typeof id === 'string' ? id : '';
    if (!stableId.trim()) fail(`missing ${kind} ID`);
    if (nodeIds.has(stableId)) fail(kind === 'evidence' ? `duplicate evidence ID ${stableId}` : `duplicate node ID ${stableId}`);
    nodeIds.add(stableId);
  };
  registerNodeId(tree.id, 'root');
  const documentNodes = rootChildren!.filter((node) => node.type === 'document');
  const actual = new Set(documentNodes.map((node) => node.document_id));
  if (rootChildren!.length !== documentNodes.length || documentNodes.length !== expected.size || actual.size !== expected.size
    || [...expected].some((id) => !actual.has(id))) {
    fail('document branches do not match the project documents');
  }
  if (tree.source_document_ids) {
    const sourceIds = new Set(tree.source_document_ids);
    if (sourceIds.size !== expected.size || [...expected].some((id) => !sourceIds.has(id))) {
      fail('root source document references do not match the project documents');
    }
  }

  const evidenceById = new Set<string>();
  const evidenceByDocumentOrder = new Map<string, ProjectIndexTreeNode[]>();
  const evidence: ProjectIndexTreeNode[] = [];
  for (const document of documentNodes) {
    registerNodeId(document.id, 'document');
    const documentId = document.document_id;
    const documentChildren = document.children;
    if (!documentId || !Array.isArray(documentChildren)) fail('document branch is missing children');
    const validatedDocumentId = documentId!;
    const collectSectionEvidence = (section: ProjectIndexTreeNode): number => {
      if (!['section', 'subsection', 'topic'].includes(section.type)) fail(`unsupported section node type ${section.type}`);
      registerNodeId(section.id, 'section');
      if (!Number.isInteger(section.start_page) || !Number.isInteger(section.end_page)
        || section.start_page! < 1 || section.end_page! < section.start_page!) {
        fail(`invalid page range for section ${section.id}`);
      }
      let sectionEvidenceCount = 0;
      for (const child of section.children ?? []) {
        if (['section', 'subsection', 'topic'].includes(child.type)) {
          const childEvidenceCount = collectSectionEvidence(child);
          if (child.start_page! < section.start_page! || child.end_page! > section.end_page!) {
            fail(`child page range exceeds section ${section.id}`);
          }
          sectionEvidenceCount += childEvidenceCount;
          continue;
        }
        const passage = child;
        if (!['passage', 'evidence', 'table', 'visual'].includes(passage.type)
          || !passage.id || passage.document_id !== documentId
          || !Number.isInteger(passage.page) || passage.page! < 1
          || !Number.isInteger(passage.source_order) || passage.source_order! < 1
          || typeof passage.content_reference !== 'string' || !passage.content_reference.trim()) {
          fail(`invalid source evidence in document ${documentId}`);
        }
        registerNodeId(passage.id, 'evidence');
        if (evidenceById.has(passage.id)) fail(`duplicate evidence ID ${passage.id}`);
        evidenceById.add(passage.id);
        evidence.push(passage);
        sectionEvidenceCount += 1;
        const documentOrders = evidenceByDocumentOrder.get(validatedDocumentId) ?? [];
        documentOrders.push(passage);
        evidenceByDocumentOrder.set(validatedDocumentId, documentOrders);
      }
      return sectionEvidenceCount;
    };
    const documentEvidenceCount = documentChildren!.reduce((count, section) => count + collectSectionEvidence(section), 0);
    if (!documentEvidenceCount) fail(`document ${documentId} has no source evidence`);
  }

  for (const [documentId, documentEvidence] of evidenceByDocumentOrder) {
    documentEvidence.sort((left, right) => left.source_order! - right.source_order!);
    for (const [index, passage] of documentEvidence.entries()) {
      if (index && documentEvidence[index - 1].source_order === passage.source_order) {
        fail(`duplicate source order ${passage.source_order} in document ${documentId}`);
      }
      const expectedPrevious = documentEvidence[index - 1]?.id;
      const expectedNext = documentEvidence[index + 1]?.id;
      if (passage.previous_evidence_id !== expectedPrevious || passage.next_evidence_id !== expectedNext) {
        fail(`invalid adjacent evidence links for ${passage.id}`);
      }
      if ((passage.continues_from_previous !== undefined && typeof passage.continues_from_previous !== 'boolean')
        || (passage.continues_to_next !== undefined && typeof passage.continues_to_next !== 'boolean')) {
        fail(`invalid continuation metadata for ${passage.id}`);
      }
      if (passage.continues_from_previous && !documentEvidence[index - 1]?.continues_to_next) {
        fail(`inconsistent continuation metadata for ${passage.id}`);
      }
      if (passage.continues_to_next && !documentEvidence[index + 1]?.continues_from_previous) {
        fail(`inconsistent continuation metadata for ${passage.id}`);
      }
    }
  }
}

export function selectTreeDocuments<T extends { id: string }>(
  documents: T[],
  indexedDocumentIds: ReadonlySet<string>,
  changedDocumentId?: string,
): T[] {
  if (!changedDocumentId) return documents;
  return documents.filter((document) =>
    document.id === changedDocumentId || !indexedDocumentIds.has(document.id),
  );
}

export function normalizeStructuredPageText(text: string): string | null {
  const normalized = text
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .replace(/\uFFFD/gu, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return normalized || null;
}

export function normalizePassageText(text: string): string {
  const normalized = normalizeStructuredPageText(text) ?? '';
  const lineEndHyphen = /(\p{Ll}{3,})-\n[ \t]*(\p{Ll}{2,})/gu;
  return normalized.replace(lineEndHyphen, (match, first: string, second: string, offset: number, source: string) =>
    source[offset + match.length] === '-' ? `${first}-${second}` : `${first}${second}`,
  ).replace(/\s+/gu, ' ').trim();
}

export function orderSourcePassages(passages: SourcePassage[], documentId = 'document'): void {
  passages.sort((left, right) => left.page - right.page
    || Number(left.contentType === 'image_caption') - Number(right.contentType === 'image_caption')
    || left.sourceOrder - right.sourceOrder);
  passages.forEach((passage, index) => {
    const digest = createHash('sha256')
      .update(`${documentId}\0${passage.page}\0${index + 1}\0${passage.normalizedContent ?? normalizePassageText(passage.content)}`)
      .digest('hex');
    passage.id = `P${digest}`;
    passage.sourceOrder = index + 1;
  });
}

function normalizedHeading(line: string): string {
  return line.replace(/^\s*#{1,6}\s+/u, '').replace(/^\s*\d+(?:\.\d+)*[.)]?\s+/u, '').replace(/[:\s]+$/u, '').trim();
}

function looksLikeContactInfo(value: string): boolean {
  return /[\w.+-]+@[\w.-]+\.[A-Z]{2,}/iu.test(value)
    || /https?:\/\/|www\./iu.test(value);
}

function detectHeadingLevel(line: string, previousLine: string, nextLine: string): number | null {
  const title = normalizedHeading(line);
  const words = title.split(/\s+/u);
  if (!title || title.length > 90 || words.length > 10 || /^[\s>*•▪◦-]/u.test(line)) return null;
  if (/^(?:https?:\/\/|www\.)/iu.test(title) || /\b[\w.+-]+@[\w.-]+\.[A-Z]{2,}\b/iu.test(title)) return null;
  if (/[.!?]$/u.test(title)) return null;
  const markdown = line.match(/^\s*(#{1,6})\s+/u);
  if (markdown) return markdown[1].length;
  const numbered = line.trim().match(/^(\d+(?:\.\d+)*)(?:[.)])?\s+\S/u);
  if (numbered) return numbered[1].split('.').length;
  if (line.trim().endsWith(':')) return 1;
  if (looksLikeContactInfo(nextLine)) return null;
  const hasLetters = /\p{L}/u.test(title);
  const uppercase = hasLetters && title === title.toLocaleUpperCase();
  const formatCompatible = !/[,:;|@/+\.]/u.test(title);
  if (uppercase && formatCompatible) return hasLetters ? 1 : null;
  const titleCase = words.length <= 7
    && formatCompatible
    && words.every((word) => /^[\p{Lu}\d]/u.test(word));
  const isolated = !previousLine.trim() || !nextLine.trim();
  return hasLetters && titleCase && isolated ? 1 : null;
}

function endsWithAbbreviation(text: string): boolean {
  const token = text.trim().split(/\s+/u).at(-1) ?? '';
  return /^(?:(?:\p{Lu}\.){1,3}(?:\p{Lu}\p{Ll}{1,5}\.)?|\p{Lu}\p{Ll}{1,2}\.|(?:\p{Ll}\.){2,})$/u.test(token);
}

function splitSentences(text: string): string[] {
  const pieces: string[] = [];
  const boundary = /[.!?]+["')\]]*(?=\s+[\p{L}\p{N}])/gu;
  let start = 0;
  for (const match of text.matchAll(boundary)) {
    const end = (match.index ?? 0) + match[0].length;
    const preceding = text.slice(start, end).trimEnd();
    if (endsWithAbbreviation(preceding)) continue;
    if (preceding) pieces.push(preceding);
    start = end;
    while (/\s/u.test(text[start] ?? '')) start += 1;
  }
  const remainder = text.slice(start).trim();
  if (remainder) pieces.push(remainder);
  return pieces.length ? pieces : [text.trim()].filter(Boolean);
}

function splitOversizedText(text: string, maximumCharacters: number): string[] {
  const limit = Math.max(1, maximumCharacters);
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > limit) {
    const commaBoundary = remaining.lastIndexOf(', ', limit);
    const semicolonBoundary = remaining.lastIndexOf('; ', limit);
    const colonBoundary = remaining.lastIndexOf(': ', limit);
    const punctuationBoundary = Math.max(commaBoundary, semicolonBoundary, colonBoundary);
    const splitAt = punctuationBoundary >= limit * 0.6
      ? punctuationBoundary + 1
      : remaining.lastIndexOf(' ', limit);
    if (splitAt <= 0) break;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function createSourcePassages(
  pages: Array<{ pageNumber: number; text: string }>,
  maximumCharacters = 2800,
): SourcePassage[] {
  const passages: SourcePassage[] = [];
  let sourceOrder = 0;
  let activeSectionPath = ['Unclassified'];
  for (const page of pages) {
    const rawLines = page.text.replace(/\r\n?/gu, '\n').split('\n');
    const lines = rawLines.map((line) => line.trim());
    let block: string[] = [];
    const flushBlock = () => {
      if (!block.length) return;
      const original = block.join('\n').trim();
      const normalized = normalizePassageText(original);
      block = [];
      if (!normalized) return;
      let currentOriginal = '';
      let currentNormalized = '';
      let currentContinuesFromPrevious = false;
      let currentContinuesToNext = false;
      const append = () => {
        if (!currentOriginal || !currentNormalized) return;
        sourceOrder += 1;
        passages.push({
          id: `P${String(sourceOrder).padStart(6, '0')}`,
          sourceOrder,
          page: page.pageNumber,
          content: currentOriginal,
          normalizedContent: currentNormalized,
          sectionTitle: activeSectionPath.at(-1) ?? 'Unclassified',
          sectionPath: [...activeSectionPath],
          continuesFromPrevious: currentContinuesFromPrevious,
          continuesToNext: currentContinuesToNext,
        });
        currentOriginal = '';
        currentNormalized = '';
        currentContinuesFromPrevious = false;
        currentContinuesToNext = false;
      };
      for (const sentence of splitSentences(original)) {
        const sentenceChunks = splitOversizedText(sentence, maximumCharacters);
        if (sentenceChunks.length > 1) {
          append();
          for (const [index, sentenceChunk] of sentenceChunks.entries()) {
            currentOriginal = sentenceChunk;
            currentNormalized = normalizePassageText(sentenceChunk);
            currentContinuesFromPrevious = index > 0;
            currentContinuesToNext = index < sentenceChunks.length - 1;
            append();
          }
          continue;
        }
        for (const sentenceChunk of sentenceChunks) {
          const normalizedSentence = normalizePassageText(sentenceChunk);
          if (currentNormalized && currentNormalized.length + normalizedSentence.length + 1 > maximumCharacters) append();
          currentOriginal = currentOriginal ? `${currentOriginal} ${sentenceChunk}` : sentenceChunk;
          currentNormalized = currentNormalized ? `${currentNormalized} ${normalizedSentence}` : normalizedSentence;
        }
      }
      append();
    };

    for (const [index, line] of lines.entries()) {
      if (!line) {
        flushBlock();
        continue;
      }
      const headingLevel = detectHeadingLevel(line, lines[index - 1] ?? '', lines[index + 1] ?? '');
      if (headingLevel) {
        flushBlock();
        const parentPath = activeSectionPath.slice(0, headingLevel - 1);
        while (parentPath.length < headingLevel - 1) parentPath.push('Unclassified');
        activeSectionPath = [...parentPath, normalizedHeading(line).slice(0, 180) || 'Unclassified'];
        continue;
      }
      const bullet = /^[\s]*(?:[-*•◦▪‣]|\d+[.)])\s+/u.test(line);
      if (bullet && block.length) flushBlock();
      block.push(line);
    }
    flushBlock();
  }
  return passages;
}

export function groupSourcePassagesBySection(passages: SourcePassage[]): ProposedIndexSection[] {
  const roots: ProposedIndexSection[] = [];
  const sections = new Map<string, ProposedIndexSection>();
  for (const passage of passages) {
    const title = passage.sectionTitle?.trim() || 'Unclassified';
    const path = passage.sectionPath?.length ? passage.sectionPath : [title];
    let parent: ProposedIndexSection | undefined;
    const pathParts: string[] = [];
    for (const part of path) {
      pathParts.push(part);
      const key = pathParts.map((value) => value.toLocaleLowerCase()).join('\0');
      let section = sections.get(key);
      if (!section) {
        section = { title: part, summary: '', passageIds: [], children: [] };
        sections.set(key, section);
        (parent ? parent.children! : roots).push(section);
      }
      parent = section;
    }
    parent!.passageIds.push(passage.id);
  }
  return roots;
}

export function summarizeSourcePassages(passages: SourcePassage[]): string {
  const excerpts = passages.slice(0, 3).flatMap((passage) => {
    const content = passage.normalizedContent ?? normalizePassageText(passage.content);
    const sentence = splitSentences(content)[0]?.trim() ?? '';
    if (sentence.length <= 240) return sentence ? [sentence] : [];
    const boundary = sentence.lastIndexOf(' ', 240);
    return [`${sentence.slice(0, boundary > 0 ? boundary : 240)}...`];
  });
  return excerpts.length ? `Source content: ${excerpts.join(' | ')}` : '';
}