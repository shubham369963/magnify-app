import assert from "node:assert/strict";
import { test } from '@jest/globals';
import { imagePagesFromListing, normalizePageText, selectImagePages, splitPageText, stableVectorPointId } from '../../dist/document-service/pdf-chunking.utils.js';

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

test("image page listing yields unique sorted image-bearing pages and ignores mask rows", () => {
  const listing = [
    "page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio",
    "1 0 image 640 480 rgb 3 8 jpeg no 12 0 72 72 30K 5%",
    "3 0 image 800 600 rgb 3 8 jpeg no 21 0 90 90 42K 3%",
    "3 1 smask 800 600 gray 1 8 image no 21 0 90 90 10K 1%",
    "4 0 smask 800 600 gray 1 8 image no 30 0 90 90 10K 1%",
    "5 0 mask 800 600 gray 1 1 image no 31 0 90 90 10K 1%",
  ].join("\n");
  assert.deepEqual(imagePagesFromListing(listing), [1, 3]);
});

test("image page selection skips pages whose only images are small or repeated logos", () => {
  const filter = { minWidth: 150, minHeight: 150, minDisplayPoints: 72, maxRepeatPages: 3 };
  const listing = [
    "page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio",
    "----------------------------------------------------------------------------------------",
    // Header logo repeated on pages 1-4.
    ...[1, 2, 3, 4].map((page) => `${page} 0 image 400 400 rgb 3 8 jpeg no 7 0 300 300 20K 4%`),
    // Tiny icon in pixels.
    "5 1 image 64 64 rgb 3 8 image no 40 0 72 72 2K 10%",
    // Company-name banner: wide but short.
    "6 0 image 900 90 rgb 3 8 jpeg no 41 0 150 150 9K 3%",
    // Plenty of pixels but printed under one inch on the page.
    "7 0 image 600 600 rgb 3 8 jpeg no 42 0 1200 1200 30K 2%",
    // Real figure alongside the repeated logo.
    "2 1 image 1200 800 rgb 3 8 jpeg no 50 0 150 150 90K 3%",
    // Inline figure without an object reference.
    "8 0 image 500 400 rgb 3 8 image no [inline] 100 100 25K 4%",
  ].join("\n");
  assert.deepEqual(selectImagePages(listing, filter), { pages: [2, 8], images: 9, skippedImages: 7 });
});

test("image page selection filters can be disabled", () => {
  const listing = [
    "1 0 image 32 32 rgb 3 8 image no 7 0 1200 1200 1K 10%",
    "2 0 image 32 32 rgb 3 8 image no 7 0 1200 1200 1K 10%",
  ].join("\n");
  const disabled = { minWidth: 0, minHeight: 0, minDisplayPoints: 0, maxRepeatPages: 0 };
  assert.deepEqual(selectImagePages(listing, disabled).pages, [1, 2]);
  assert.deepEqual(selectImagePages(listing, { ...disabled, maxRepeatPages: 1 }).pages, []);
});
