import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { coversIndexTreeQuery, deduplicateTreeEvidence, expandIncompleteTreeEvidence, filterRelevantDocuments, mergeIndexTreeSelections, parseRelevantDocumentIndexes, projectSearchFilter, rankIndexTreeCandidates, scoreIndexTreeCandidates, selectDistributedFallbackIndexes, selectIndexTreeCandidateIndexes, selectIndexTreeFallbackIndexes } from '../../dist/chat-service/rag.utils.js';

test('Qdrant search requires both the verified owner and selected project', () => {
  assert.deepEqual(projectSearchFilter('user_a', 'project_a'), {
    must: [
      { key: 'metadata.project_id', match: { value: 'project_a' } },
      { key: 'metadata.owner_clerk_id', match: { value: 'user_a' } },
    ],
  });
});

test('RAG retrieval keeps relevant page chunks and excludes weak matches', () => {
  const relevant = { pageContent: 'The project uses Python.' };
  const unrelated = { pageContent: 'Configure the local database.' };
  assert.deepEqual(filterRelevantDocuments([[relevant, 0.42], [unrelated, 0.31]], 0.35), [relevant]);
});

test('relevance selection accepts only unique in-range candidate ids', () => {
  assert.deepEqual(
    parseRelevantDocumentIndexes('{"relevant_ids":["D2","D2","D9","other"]}', 3),
    [1],
  );
});

test('relevance selection rejects malformed model output', () => {
  assert.equal(parseRelevantDocumentIndexes('not json', 3), null);
  assert.equal(parseRelevantDocumentIndexes('{"relevant_ids":"D1"}', 3), null);
});

test('tree candidate ranking finds multiple lexical branches and preserves technical terms', () => {
  const candidates = [
    { title: 'Carbon fixation', summary: 'RuBP combines with carbon dioxide.' },
    { title: 'Reduction', summary: 'ATP and NADPH are consumed to form G3P.' },
    { title: 'Unrelated topic', summary: 'Cell membrane transport.' },
  ];
  assert.deepEqual(rankIndexTreeCandidates('carbon fixation ATP and NADPH', candidates, 2), [0, 1]);
});

test('tree candidate ranking retains single-digit values in queries', () => {
  assert.deepEqual(
    rankIndexTreeCandidates('pH 7', [{ title: 'pH scale', content: 'A value of 7 is neutral.' }], 1),
    [0],
  );
});

test('tree candidate scoring distinguishes exact phrase and term coverage', () => {
  const scores = scoreIndexTreeCandidates('serial number AX-17', [
    { content: 'The serial number is AX-17.' },
    { content: 'Serial records are stored separately.' },
  ]);
  assert.equal(scores[0].index, 0);
  assert.equal(scores[0].phraseMatch, false);
  assert.deepEqual(scores[0].matchedTerms, ['serial', 'number', 'ax17']);
  assert.equal(scores.some((candidate) => candidate.phraseMatch), false);
  const phraseScores = scoreIndexTreeCandidates('serial number AX-17', [
    { content: 'Serial number AX-17 was recorded.' },
  ]);
  assert.equal(phraseScores[0].phraseMatch, true);
});

test('tree fallback selection is deterministic and covers late candidates', () => {
  assert.deepEqual(selectDistributedFallbackIndexes(8, 4), [1, 3, 5, 7]);
  assert.deepEqual(selectDistributedFallbackIndexes(3, 8), [0, 1, 2]);
  assert.deepEqual(selectDistributedFallbackIndexes(0, 8), []);
});

test('lexical candidate shortlists retain bounded document-wide exploration', () => {
  const scored = Array.from({ length: 15 }, (_unused, index) => ({
    index,
    score: 10 - index / 10,
    matchedTerms: ['topic'],
    queryTermCount: 1,
    phraseMatch: false,
  }));
  const shortlist = selectIndexTreeCandidateIndexes(scored, 25, 20);
  assert.equal(shortlist.length, 20);
  assert.ok(shortlist.some((index) => index >= 15));
  assert.deepEqual(selectIndexTreeCandidateIndexes([], 8, 4), [1, 3, 5, 7]);
});

test('weak lexical fallback mixes top matches with deterministic coverage', () => {
  const weakScores = [{ index: 0, score: 1, matchedTerms: ['common'], queryTermCount: 5, phraseMatch: false }];
  assert.deepEqual(selectIndexTreeFallbackIndexes(weakScores, 10, 4), [0, 1, 3, 6]);
  const exactScores = [{ index: 8, score: 8, matchedTerms: ['serial', 'number'], queryTermCount: 2, phraseMatch: true }];
  assert.deepEqual(selectIndexTreeFallbackIndexes(exactScores, 10, 3), [8]);
});

test('tree selection merge deduplicates model and deterministic results', () => {
  assert.deepEqual(mergeIndexTreeSelections([2, 0], [0, 1], 3), [2, 0, 1]);
});

test('tree query coverage skips semantic selection only when all requested terms are present', () => {
  const candidates = [{ title: 'Outcome', summary: 'The result changed.' }, { title: 'Costs', summary: 'Increased by 12.' }];
  assert.equal(coversIndexTreeQuery('Explain the outcome and costs', candidates), true);
  assert.equal(coversIndexTreeQuery('Explain the outcome and energy use', candidates), false);
});

test('tree retrieval expands incomplete passages only through linked evidence', () => {
  const first = { id: 'e1', document_id: 'doc-1', source_order: 1, content: 'The remaining five are...', next_evidence_id: 'e2' };
  const second = { id: 'e2', document_id: 'doc-1', source_order: 2, content: 'converted into enough RuBP to restart the cycle.' };
  const unrelated = { id: 'e3', document_id: 'doc-1', source_order: 3, content: 'A separate section.' };
  assert.deepEqual(expandIncompleteTreeEvidence([first], [first, second, unrelated], 2), [first, second]);
  assert.deepEqual(expandIncompleteTreeEvidence([second], [first, second], 2), [second]);
  const continuation = { id: 'e4', document_id: 'doc-1', source_order: 2, content: 'and completes the reaction.', previous_evidence_id: 'e1' };
  assert.deepEqual(expandIncompleteTreeEvidence([continuation], [first, continuation], 2), [continuation, first]);
  const otherDocument = { ...second, id: 'other-document', document_id: 'doc-2' };
  assert.deepEqual(expandIncompleteTreeEvidence([first], [first, otherDocument], 2), [first]);
  const splitFirst = { id: 'split-1', document_id: 'doc-1', source_order: 3, content: 'A long fact ending mid-sentence', continues_to_next: true, next_evidence_id: 'split-2' };
  const splitNext = { id: 'split-2', document_id: 'doc-1', source_order: 4, content: 'continues with its qualifying details.', continues_from_previous: true, previous_evidence_id: 'split-1' };
  assert.deepEqual(expandIncompleteTreeEvidence([splitFirst], [splitFirst, splitNext], 1), [splitFirst, splitNext]);
});

test('tree evidence deduplication preserves citation aliases and separate page provenance', () => {
  const passage = 'The Calvin cycle converts carbon dioxide into sugars through a sequence of light-independent reactions and regenerates RuBP for another cycle.';
  const result = deduplicateTreeEvidence([
    { id: 'e1', document_id: 'doc-1', page: 6, content_type: 'text', section_title: 'Calvin Cycle', content: passage },
    { id: 'e2', document_id: 'doc-1', page: 6, content_type: 'text', section_title: 'Light-Independent Reactions', content: `Introductory note. ${passage}` },
    { id: 'e3', document_id: 'doc-1', page: 7, content_type: 'text', section_title: 'Calvin Cycle', content: passage },
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0].duplicate_evidence_ids, ['e2']);
  assert.deepEqual(result[0].section_titles, ['Calvin Cycle', 'Light-Independent Reactions']);
  assert.equal(result[1].id, 'e3');
  assert.equal(result[1].page, 7);
});

test('tree evidence keeps distinct passages that share most of their wording', () => {
  const shared = 'The instrument records a calibrated measurement during each operating cycle and stores the result with its source identifier for later review. ';
  const result = deduplicateTreeEvidence([
    { id: 'e1', document_id: 'doc-1', page: 2, content_type: 'text', section_title: 'Results', content: `${shared}The recorded value was 8.2 units.` },
    { id: 'e2', document_id: 'doc-1', page: 2, content_type: 'text', section_title: 'Results', content: `${shared}The recorded value was 9.1 units.` },
  ]);
  assert.equal(result.length, 2);
});