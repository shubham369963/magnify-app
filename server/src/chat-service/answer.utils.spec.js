import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { INSUFFICIENT_EVIDENCE_ANSWER, parseGroundedResponse } from '../../dist/chat-service/answer.utils.js';

test('grounded responses return only a verbatim source excerpt and preserve original evidence', () => {
  const originalContent = 'Education:\nRajarambapu Institute of Technology &amp; Engineering — CGPA: 8.30/10';
  const response = parseGroundedResponse(JSON.stringify({
    answer: 'Rajarambapu Institute of Technology &amp; Engineering',
    sources: [{ id: 'V1', excerpt: 'Rajarambapu Institute of Technology &amp; Engineering' }],
  }), [{ id: 'V1', content: originalContent, source: 'resume.pdf', page: 1 }]);

  assert.equal(response.answer, '- Rajarambapu Institute of Technology &amp; Engineering');
  assert.equal(response.sources[0].excerpt, 'Rajarambapu Institute of Technology &amp; Engineering');
  assert.equal(response.sources[0].content, originalContent);
});

test('grounded response rejects paraphrased excerpts and unknown evidence IDs', () => {
  const response = parseGroundedResponse(JSON.stringify({
    answer: 'The school is in a town.',
    sources: [
      { id: 'V1', excerpt: 'The college is in a nearby town.' },
      { id: 'V9', excerpt: 'A source quote.' },
    ],
  }), [{ id: 'V1', content: 'Rajarambapu Institute of Technology, Sangli.' }]);

  assert.deepEqual(response, { answer: INSUFFICIENT_EVIDENCE_ANSWER, sources: [] });
});

test('alternate evidence IDs retain provenance while deduplicating their displayed source', () => {
  const evidence = [{ id: 'E1', alternateIds: ['E2'], content: 'CGPA: 8.30/10' }];
  const response = parseGroundedResponse(JSON.stringify({
    answer: 'The CGPA is 8.30/10.',
    sources: [{ id: 'E2', excerpt: 'CGPA: 8.30/10' }],
  }), evidence);

  assert.equal(response.sources.length, 1);
  assert.deepEqual(response.sources[0].evidenceIds, ['E1', 'E2']);
});

test('verbatim excerpt offsets remain correct after astral Unicode characters', () => {
  const response = parseGroundedResponse(JSON.stringify({
    answer: 'The value is alpha beta.',
    sources: [{ id: 'V1', excerpt: 'alpha βeta' }],
  }), [{ id: 'V1', content: '🧪 Test result: alpha βeta.' }]);

  assert.equal(response.sources[0].excerpt, 'alpha βeta');
});

test('answer cleanup removes source citations and links without altering the source quote', () => {
  const response = parseGroundedResponse(JSON.stringify({
    answer: 'The result is **8.30/10** [resume.pdf, p. 1].\nSources: [resume.pdf](https://example.test/resume.pdf)',
    sources: [{ id: 'V1', excerpt: 'CGPA: 8.30/10' }],
  }), [{ id: 'V1', content: 'CGPA: 8.30/10', source: 'resume.pdf', page: 1 }]);

  assert.equal(response.answer, '- The result is **8.30/10**.');
  assert.equal(response.sources[0].excerpt, 'CGPA: 8.30/10');
});

test('grounded answers become Markdown bullets and emphasize labeled key values', () => {
  const response = parseGroundedResponse(JSON.stringify({
    answer: 'Degree: B.Tech. in Computer Engineering\nCGPA: 8.30/10',
    sources: [{ id: 'E1', excerpt: 'B.Tech. in Computer Engineering. CGPA: 8.30/10.' }],
  }), [{ id: 'E1', content: 'B.Tech. in Computer Engineering. CGPA: 8.30/10.' }]);

  assert.equal(response.answer, '- **Degree:** B.Tech. in Computer Engineering\n- **CGPA:** **8.30/10**');
});

test('grounded sources are sorted by file, page, and source order', () => {
  const evidence = [
    { id: 'E3', content: 'Page 3 passage.', source: 'report.pdf', page: 3, sourceOrder: 4 },
    { id: 'E2', content: 'Page 2 second passage.', source: 'report.pdf', page: 2, sourceOrder: 3 },
    { id: 'E1', content: 'Page 2 first passage.', source: 'report.pdf', page: 2, sourceOrder: 2 },
    { id: 'E4', content: 'Other file.', source: 'appendix.pdf', page: 9, sourceOrder: 1 },
  ];
  const response = parseGroundedResponse(JSON.stringify({
    answer: 'All details are included.',
    sources: evidence.slice().reverse().map(({ id, content }) => ({ id, excerpt: content })),
  }), evidence);

  assert.deepEqual(response.sources.map(({ id }) => id), ['E1', 'E2', 'E3', 'E4']);
});

test('grounding accepts exact excerpts longer than 1200 characters', () => {
  const excerpt = `Start ${'supporting detail '.repeat(100)}end.`;
  const response = parseGroundedResponse(JSON.stringify({
    answer: 'The document contains the full detail.',
    sources: [{ id: 'E1', excerpt }],
  }), [{ id: 'E1', content: excerpt, source: 'report.pdf', page: 1 }]);

  assert.equal(response.sources.length, 1);
  assert.equal(response.sources[0].excerpt, excerpt);
});

test('answer cleanup preserves substantive text following a Sources label', () => {
  const response = parseGroundedResponse(JSON.stringify({
    answer: 'The report compares two methods.\nSources: of variation include temperature and pressure.\nThe second method is faster.',
    sources: [{ id: 'E1', excerpt: 'The report compares two methods.' }],
  }), [{ id: 'E1', content: 'The report compares two methods. Supporting evidence.' }]);

  assert.match(response.answer, /\*\*Sources:\*\* of variation include temperature and pressure/u);
  assert.match(response.answer, /The second method is faster/u);
});