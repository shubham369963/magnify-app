import assert from "node:assert/strict";
import { test } from '@jest/globals';
import { imagePagesFromListing, normalizePageText, splitPageText, stableVectorPointId } from '../../dist/document-service/pdf-chunking.utils.js';

test("PDF page text stays together as one normalized page chunk", () => {
  assert.deepEqual(
    normalizePageText("First paragraph.\ncontinued line.\n\nSecond paragraph."),
    "First paragraph. continued line. Second paragraph.",
  );
});

test('long PDF pages split into bounded vector chunks without losing headings or text', () => {
  const text = `INTRODUCTION ${Array.from({ length: 1200 }, (_, index) => `measurement${index}`).join(' ')}`;
  const chunks = splitPageText(text);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 2800));
  assert.equal(chunks.join(' '), text);
  assert.match(chunks[0], /^INTRODUCTION/u);
});

test("empty PDF pages do not produce a text chunk", () => {
  assert.equal(normalizePageText(" \n\t "), null);
});

test('vector point IDs are stable and change when indexed evidence changes', () => {
  const pointId = stableVectorPointId('document-1', 4, 'text', 'Evidence text');

  assert.match(pointId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(pointId, stableVectorPointId('document-1', 4, 'text', 'Evidence text'));
  assert.notEqual(pointId, stableVectorPointId('document-1', 5, 'text', 'Evidence text'));
  assert.notEqual(pointId, stableVectorPointId('document-1', 4, 'image_caption', 'Evidence text'));
  assert.notEqual(pointId, stableVectorPointId('document-1', 4, 'text', 'Updated evidence text'));
});

test("image page listing yields unique sorted image-bearing pages", () => {
  const listing = [
    "page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio",
    "1 0 image 640 480 rgb 3 8 jpeg no 12 0 72 72 30K 5%",
    "3 0 image 800 600 rgb 3 8 jpeg no 21 0 90 90 42K 3%",
    "3 1 smask 800 600 gray 1 8 image no 21 0 90 90 10K 1%",
  ].join("\n");
  assert.deepEqual(imagePagesFromListing(listing), [1, 3]);
});
