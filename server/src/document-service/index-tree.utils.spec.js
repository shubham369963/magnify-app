import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { createIndexSectionId, createSourcePassages, groupSourcePassagesBySection, linkAdjacentTreeEvidence, normalizePassageText, normalizeStructuredPageText, orderSourcePassages, selectTreeDocuments, summarizeSourcePassages, validateProjectIndexTree } from '../../dist/document-service/index-tree.utils.js';

test('structured page normalization preserves paragraph boundaries', () => {
  assert.equal(
    normalizeStructuredPageText('  Section title  \r\nFirst paragraph.\r\n\r\nSecond paragraph.  '),
    'Section title\nFirst paragraph.\n\nSecond paragraph.',
  );
  assert.equal(normalizeStructuredPageText('Cafe\u0301 ﬁle \uFFFD name'), 'Café file name');
});

test('incremental tree builds include the changed and previously unindexed documents', () => {
  const documents = [{ id: 'existing' }, { id: 'changed' }, { id: 'new' }];
  assert.deepEqual(
    selectTreeDocuments(documents, new Set(['existing', 'changed']), 'changed'),
    [{ id: 'changed' }, { id: 'new' }],
  );
  assert.deepEqual(selectTreeDocuments(documents, new Set(['existing']), undefined), documents);
});

test('nested section IDs stay unique when sections share their first descendant passage', () => {
  const parentSectionId = createIndexSectionId('doc-1', 1);
  const childSectionId = createIndexSectionId('doc-1', 2);

  assert.notEqual(parentSectionId, childSectionId);
});

test('evidence links follow document reading order across section boundaries', () => {
  const first = { id: 'e1', document_id: 'doc-1', source_order: 1 };
  const second = { id: 'e2', document_id: 'doc-1', source_order: 2 };
  const third = { id: 'e3', document_id: 'doc-1', source_order: 3 };
  linkAdjacentTreeEvidence([first, third, second]);
  assert.equal(first.next_evidence_id, 'e2');
  assert.equal(second.previous_evidence_id, 'e1');
  assert.equal(second.next_evidence_id, 'e3');
  assert.equal(third.previous_evidence_id, 'e2');
});

test('project tree validation requires every document and unique page-level evidence', () => {
  const tree = {
    id: 'project-1',
    type: 'root',
    title: 'Project index',
    source_document_ids: ['doc-1'],
    children: [{
      id: 'document-doc-1',
      type: 'document',
      title: 'source.pdf',
      document_id: 'doc-1',
      children: [{
        id: 'section-1',
        type: 'section',
        title: 'Findings',
        start_page: 1,
        end_page: 1,
        children: [{
          id: 'evidence-1',
          type: 'passage',
          title: 'Page 1',
          document_id: 'doc-1',
          page: 1,
          source_order: 1,
          content_reference: 'Original source passage.',
        }],
      }],
    }],
  };
  assert.doesNotThrow(() => validateProjectIndexTree(tree, ['doc-1']));
  assert.throws(() => validateProjectIndexTree(tree, ['doc-1', 'doc-2']), /document branches/);
  tree.children[0].children[0].children.push({ ...tree.children[0].children[0].children[0] });
  assert.throws(() => validateProjectIndexTree(tree, ['doc-1']), /duplicate evidence ID/);
});

test('project tree validation rejects missing cross-section adjacency links', () => {
  const tree = {
    id: 'project-1',
    type: 'root',
    title: 'Project index',
    source_document_ids: ['doc-1'],
    children: [{
      id: 'document-doc-1',
      type: 'document',
      title: 'source.pdf',
      document_id: 'doc-1',
      children: [1, 2].map((order) => ({
        id: `section-${order}`,
        type: 'section',
        title: `Section ${order}`,
        start_page: order,
        end_page: order,
        children: [{
          id: `evidence-${order}`,
          type: 'passage',
          title: `Page ${order}`,
          document_id: 'doc-1',
          page: order,
          source_order: order,
          content_reference: `Source passage ${order}.`,
        }],
      })),
    }],
  };
  const evidence = tree.children[0].children.flatMap((section) => section.children);
  linkAdjacentTreeEvidence(evidence);
  assert.doesNotThrow(() => validateProjectIndexTree(tree, ['doc-1']));
  evidence[0].continues_to_next = true;
  evidence[1].continues_from_previous = true;
  assert.doesNotThrow(() => validateProjectIndexTree(tree, ['doc-1']));
  evidence[1].continues_from_previous = false;
  assert.throws(() => validateProjectIndexTree(tree, ['doc-1']), /inconsistent continuation metadata/);
  evidence[0].continues_to_next = false;
  evidence[0].next_evidence_id = undefined;
  assert.throws(() => validateProjectIndexTree(tree, ['doc-1']), /adjacent evidence links/);
});

test('source passages stay bounded and retain page references', () => {
  const passages = createSourcePassages([
    { pageNumber: 4, text: `First paragraph.\n\n${'detail sentence. '.repeat(100)}` },
  ], 200);
  assert.ok(passages.length > 1);
  assert.ok(passages.every((passage) => passage.content.length <= 200));
  assert.ok(passages.every((passage) => passage.page === 4));
  assert.deepEqual(passages.map((passage) => passage.sourceOrder), passages.map((_passage, index) => index + 1));
  orderSourcePassages(passages, 'doc-test');
  assert.equal(new Set(passages.map((passage) => passage.id)).size, passages.length);
  assert.ok(passages.every((passage) => /^P[\da-f]{64}$/u.test(passage.id)));
  assert.ok(passages.every((passage) => /[.!?]$/.test(passage.content)));
});

test('100-page PDFs retain all source text in bounded page-referenced passages', () => {
  const pages = Array.from({ length: 100 }, (_value, index) => ({
    pageNumber: index + 1,
    text: `Page ${index + 1} records detailed measurements and observations. ${'Repeated source detail remains searchable. '.repeat(100)}`,
  }));
  const passages = createSourcePassages(pages);

  assert.equal(new Set(passages.map(({ page }) => page)).size, 100);
  assert.ok(passages.every(({ normalizedContent }) => normalizedContent.length <= 2800));
  for (const page of pages) {
    const pageText = passages
      .filter((passage) => passage.page === page.pageNumber)
      .map((passage) => passage.content)
      .join(' ');
    assert.equal(pageText, page.text.trim());
  }
});

test('an oversized sentence splits on a natural boundary without dropping source text', () => {
  const original = `The report records calibration, operating conditions, instrument serial number, measurement date, and source details, ${'a detailed measurement '.repeat(40)}and a final conclusion.`;
  const passages = createSourcePassages([{ pageNumber: 9, text: original }], 180);
  assert.ok(passages.length > 1);
  assert.ok(passages.every((passage) => passage.content.length <= 180));
  assert.equal(passages.map((passage) => passage.content).join(' '), original);
  assert.ok(passages.some((passage) => passage.content.endsWith(',')));
  assert.equal(passages[0].continuesToNext, true);
  assert.equal(passages[1].continuesFromPrevious, true);
});

test('image captions are ordered beside their page and receive stable document-scoped IDs', () => {
  const passages = createSourcePassages([
    { pageNumber: 6, text: 'Text on page six.' },
    { pageNumber: 7, text: 'Text on page seven.' },
  ]);
  passages.push({ id: 'temporary-caption', sourceOrder: 3, page: 6, content: 'A chart on page six.', contentType: 'image_caption' });
  orderSourcePassages(passages, 'doc-1');
  const firstBuild = passages.map(({ page, contentType, sourceOrder, id }) => ({ page, contentType, sourceOrder, id }));
  assert.deepEqual(firstBuild.map(({ page, contentType, sourceOrder }) => ({ page, contentType, sourceOrder })), [
    { page: 6, contentType: undefined, sourceOrder: 1 },
    { page: 6, contentType: 'image_caption', sourceOrder: 2 },
    { page: 7, contentType: undefined, sourceOrder: 3 },
  ]);
  assert.equal(new Set(firstBuild.map(({ id }) => id)).size, 3);
  const rebuilt = createSourcePassages([
    { pageNumber: 6, text: 'Text on page six.' },
    { pageNumber: 7, text: 'Text on page seven.' },
  ]);
  rebuilt.push({ id: 'temporary-caption', sourceOrder: 3, page: 6, content: 'A chart on page six.', contentType: 'image_caption' });
  orderSourcePassages(rebuilt, 'doc-1');
  assert.deepEqual(rebuilt.map(({ id }) => id), firstBuild.map(({ id }) => id));
  orderSourcePassages(rebuilt, 'doc-2');
  assert.ok(rebuilt.every(({ id }, index) => id !== firstBuild[index].id));
});

test('a single-page resume keeps multiple headings, bullets, and degree evidence in their own sections', () => {
  const passages = createSourcePassages([{ pageNumber: 1, text: [
    'PERSONAL INFORMATION',
    '',
    'shubham@example.com | https://example.com',
    '',
    'SKILLS',
    'TypeScript, Node.js, C++',
    'HTML, CSS, SQL, C++',
    '',
    'EDUCATION',
    'B.Tech. in Computer Engineering, 2021-2025. CGPA: 8.30/10.',
    '',
    'PROJECTS',
    '- Built a search service that indexes PDF files.',
    '',
    'AWARDS AND CERTIFICATIONS',
    'Cloud certification, 2024.',
  ].join('\n') }]);
  const sections = groupSourcePassagesBySection(passages);
  assert.deepEqual(sections.map(({ title }) => title), [
    'PERSONAL INFORMATION', 'SKILLS', 'EDUCATION', 'PROJECTS', 'AWARDS AND CERTIFICATIONS',
  ]);
  const education = sections.find(({ title }) => title === 'EDUCATION');
  const educationPassage = passages.find(({ id }) => education.passageIds.includes(id));
  assert.match(educationPassage.content, /B\.Tech\. in Computer Engineering, 2021-2025\. CGPA: 8\.30\/10\./u);
  assert.equal(educationPassage.page, 1);
  assert.match(sections.find(({ title }) => title === 'SKILLS').passageIds.map((id) => passages.find((item) => item.id === id).content).join(' '), /Node\.js, C\+\+/u);
  assert.match(sections.find(({ title }) => title === 'SKILLS').passageIds.map((id) => passages.find((item) => item.id === id).content).join(' '), /HTML, CSS, SQL/u);
  assert.match(summarizeSourcePassages([educationPassage]), /B\.Tech\. in Computer Engineering/u);
});

test('an unlabeled contact block remains unclassified rather than inventing a section', () => {
  const passages = createSourcePassages([{ pageNumber: 1, text: [
    'SHUBHAM HALADE',
    'shubham@example.com | https://example.com',
    '',
    'Skills',
    'TypeScript and Node.js.',
  ].join('\n') }]);
  assert.deepEqual(groupSourcePassagesBySection(passages).map(({ title }) => title), ['Unclassified', 'Skills']);
  assert.match(passages[0].content, /SHUBHAM HALADE.*shubham@example\.com/su);
});

test('arbitrary and repeated headings continue across multi-page source text', () => {
  const passages = createSourcePassages([
    { pageNumber: 1, text: 'RESEARCH INTERESTS\nRenewable energy systems and optimization.' },
    { pageNumber: 2, text: 'RESEARCH INTERESTS\nModeling and simulation of storage.' },
  ]);
  const section = groupSourcePassagesBySection(passages)[0];
  assert.equal(section.title, 'RESEARCH INTERESTS');
  assert.equal(section.passageIds.length, 2);
  assert.deepEqual(passages.map(({ page }) => page), [1, 2]);
});

test('explicit numbered and Markdown headings retain a generic nested outline', () => {
  const passages = createSourcePassages([{ pageNumber: 2, text: [
    '# Findings',
    'The measurements are summarized below.',
    '1.1 Measurements',
    'The recorded value is 8.4 units.',
    '1.1.1 Calibration',
    'The instrument was calibrated before use.',
  ].join('\n\n') }]);
  const sections = groupSourcePassagesBySection(passages);
  assert.equal(sections[0].title, 'Findings');
  assert.equal(sections[0].children[0].title, 'Measurements');
  assert.equal(sections[0].children[0].children[0].title, 'Calibration');
  assert.deepEqual(passages.map(({ sectionPath }) => sectionPath), [
    ['Findings'],
    ['Findings', 'Measurements'],
    ['Findings', 'Measurements', 'Calibration'],
  ]);
});

test('rebuilding the same document preserves passage IDs and document-local links', () => {
  const buildTree = () => {
    const passages = createSourcePassages([
      { pageNumber: 1, text: 'Education\nB.Tech. in Computer Engineering.' },
      { pageNumber: 2, text: 'Education\nCGPA: 8.30/10.' },
    ]);
    orderSourcePassages(passages, 'doc-stable');
    const sections = groupSourcePassagesBySection(passages).map((section) => ({
      id: `section-${section.passageIds[0]}`,
      type: 'section',
      title: section.title,
      summary: summarizeSourcePassages(passages.filter(({ id }) => section.passageIds.includes(id))),
      start_page: Math.min(...passages.filter(({ id }) => section.passageIds.includes(id)).map(({ page }) => page)),
      end_page: Math.max(...passages.filter(({ id }) => section.passageIds.includes(id)).map(({ page }) => page)),
      children: passages.filter(({ id }) => section.passageIds.includes(id)).map((passage) => ({
        id: `evidence-doc-stable-${passage.id}`,
        type: 'passage',
        document_id: 'doc-stable',
        page: passage.page,
        source_order: passage.sourceOrder,
        content_reference: passage.content,
      })),
    }));
    const evidence = sections.flatMap((section) => section.children);
    linkAdjacentTreeEvidence(evidence);
    const tree = {
      id: 'project-stable',
      type: 'root',
      title: 'Stable index',
      source_document_ids: ['doc-stable'],
      children: [{
        id: 'document-doc-stable',
        type: 'document',
        title: 'resume.pdf',
        document_id: 'doc-stable',
        children: sections,
      }],
    };
    validateProjectIndexTree(tree, ['doc-stable']);
    return tree;
  };
  const firstBuild = buildTree();
  const rebuilt = buildTree();
  assert.deepEqual(rebuilt, firstBuild);
  const evidence = firstBuild.children[0].children.flatMap(({ children }) => children);
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0].next_evidence_id, evidence[1].id);
  assert.equal(evidence[1].previous_evidence_id, evidence[0].id);
});

test('normalization repairs line wraps while preserving meaningful hyphens, URLs, and symbols', () => {
  const passages = createSourcePassages([{ pageNumber: 3, text: [
    'Worked on inter-',
    'national data and well-',
    'known Node.js tools, plus state-',
    'of-the-art systems.',
    'Also used cloud-',
    'native tooling.',
    'URL: https://example.com/a-b?x=1&y=2; C++ and state-of-the-art methods.',
  ].join('\n') }]);
  const normalized = passages.map(({ normalizedContent }) => normalizedContent).join(' ');
  assert.match(normalized, /\binternational\b/u);
  assert.match(normalized, /international data/u);
  assert.match(normalized, /wellknown Node\.js/u);
  assert.match(normalized, /state-of-the-art systems/u);
  assert.match(normalized, /cloudnative tooling/u);
  assert.equal((normalized.match(/cloudnative/gu) ?? []).length, 1);
  assert.ok(!normalized.includes('cloud-native'));
  assert.match(normalized, /https:\/\/example\.com\/a-b\?x=1&y=2/u);
  assert.match(normalized, /C\+\+ and state-of-the-art/u);
  assert.match(passages.map(({ content }) => content).join('\n'), /inter-\nnational/u);
  assert.ok(passages.every(({ page }) => page === 3));
  const normalizedOnce = normalizePassageText('inter-\nnational data with state-of-the-art tools.');
  assert.equal(normalizePassageText(normalizedOnce), normalizedOnce);
});

test('missing or ambiguous headings use an unclassified section rather than inferred facts', () => {
  const passages = createSourcePassages([{ pageNumber: 2, text: 'A degree in Computer Engineering.\nCGPA: 8.30/10.' }]);
  assert.deepEqual(groupSourcePassagesBySection(passages).map(({ title }) => title), ['Unclassified']);
  assert.equal(passages.length, 1);
  assert.match(passages[0].content, /Computer Engineering.*CGPA: 8\.30\/10/u);
});