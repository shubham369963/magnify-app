import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { markdownRehypePlugins, markdownRemarkPlugins } from "../../lib/markdown-config.mjs";

function renderMarkdown(content) {
  return renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: markdownRemarkPlugins,
    rehypePlugins: markdownRehypePlugins,
  }, content));
}

test("renders GFM tables and LaTeX math", () => {
  const html = renderMarkdown('| Term | Value |\n| --- | ---: |\n| pH | 7 |\n\nThe result is $E=mc^2$.');

  assert.match(html, /<table>/);
  assert.match(html, /<td>pH<\/td>/);
  assert.match(html, /class="katex"/);
  assert.match(html, /<math/);
});

test("decodes entities once and keeps raw HTML and unsafe links inert", () => {
  const html = renderMarkdown('RIT &amp; Engineering\n\n<img src=x onerror=alert(1)> <script>alert(1)</script> [click](javascript:alert(1))');

  assert.match(html, /RIT &amp; Engineering/);
  assert.doesNotMatch(html, /&amp;amp;/);
  assert.doesNotMatch(html, /<img\b/i);
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /onerror=/i);
  assert.doesNotMatch(html, /src=x/i);
  assert.doesNotMatch(html, /href="javascript:/i);
});