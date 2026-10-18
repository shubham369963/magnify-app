import { createHash } from 'node:crypto';

export function normalizePageText(text: string): string | null {
  const pageText = text.replace(/\s+/g, ' ').trim();
  return pageText || null;
}

export const DEFAULT_PAGE_TEXT_CHUNK_SIZE = 5600;

export function splitPageText(text: string, maximumCharacters = DEFAULT_PAGE_TEXT_CHUNK_SIZE): string[] {
  const pageText = normalizePageText(text);
  if (!pageText) return [];

  const limit = Math.max(1, maximumCharacters);
  const chunks: string[] = [];
  let remaining = pageText;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf(' ', limit);
    if (splitAt < limit * 0.6) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function stableVectorPointId(documentId: string, pageNumber: number, contentType: string, content: string): string {
  const digest = createHash('sha256')
    .update(`${documentId}\0${pageNumber}\0${contentType}\0${content}`)
    .digest();
  const bytes = digest.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface ImageFilterOptions {
  /** Minimum intrinsic width and height in pixels; smaller images are treated as icons or logos. */
  minWidth: number;
  minHeight: number;
  /** Minimum displayed width and height on the page in PDF points (72 per inch); 0 disables. */
  minDisplayPoints: number;
  /** Images whose PDF object appears on more pages than this are treated as repeated logos; 0 disables. */
  maxRepeatPages: number;
}

export const NO_IMAGE_FILTER: ImageFilterOptions = { minWidth: 0, minHeight: 0, minDisplayPoints: 0, maxRepeatPages: 0 };

export interface ImagePageSelection {
  pages: number[];
  images: number;
  skippedImages: number;
}

interface ListedImage {
  page: number;
  width: number;
  height: number;
  objectId?: string;
  xPpi: number;
  yPpi: number;
}

// `pdfimages -list` columns: page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio.
// Inline images print `[inline]` instead of `object ID`, so trailing columns are read from the end.
function parseImageListing(listing: string): ListedImage[] {
  const images: ListedImage[] = [];
  for (const line of listing.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (!/^\d+$/.test(fields[0] ?? '') || fields[2]?.toLowerCase() !== 'image') continue;
    const width = Number(fields[3]);
    const height = Number(fields[4]);
    if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
    const hasTrailingColumns = fields.length >= 15;
    const objectFields = hasTrailingColumns ? fields.slice(10, -4) : [];
    images.push({
      page: Number(fields[0]),
      width,
      height,
      objectId: objectFields.length === 2 && objectFields.every((field) => /^\d+$/.test(field))
        ? objectFields.join(' ')
        : undefined,
      xPpi: hasTrailingColumns ? Number(fields.at(-4)) : Number.NaN,
      yPpi: hasTrailingColumns ? Number(fields.at(-3)) : Number.NaN,
    });
  }
  return images;
}

function displayedPoints(pixels: number, ppi: number): number {
  return Number.isFinite(ppi) && ppi > 0 ? (pixels / ppi) * 72 : Number.POSITIVE_INFINITY;
}

export function selectImagePages(listing: string, options: ImageFilterOptions = NO_IMAGE_FILTER): ImagePageSelection {
  const images = parseImageListing(listing);
  const objectPages = new Map<string, Set<number>>();
  for (const image of images) {
    if (!image.objectId) continue;
    const pages = objectPages.get(image.objectId) ?? new Set<number>();
    pages.add(image.page);
    objectPages.set(image.objectId, pages);
  }

  const pages = new Set<number>();
  let skippedImages = 0;
  for (const image of images) {
    const repeated = options.maxRepeatPages > 0 && image.objectId !== undefined
      && (objectPages.get(image.objectId)?.size ?? 0) > options.maxRepeatPages;
    const tooSmall = image.width < options.minWidth || image.height < options.minHeight
      || displayedPoints(image.width, image.xPpi) < options.minDisplayPoints
      || displayedPoints(image.height, image.yPpi) < options.minDisplayPoints;
    if (repeated || tooSmall) skippedImages += 1;
    else pages.add(image.page);
  }
  return { pages: [...pages].sort((left, right) => left - right), images: images.length, skippedImages };
}

export function imagePagesFromListing(listing: string, options: ImageFilterOptions = NO_IMAGE_FILTER): number[] {
  return selectImagePages(listing, options).pages;
}