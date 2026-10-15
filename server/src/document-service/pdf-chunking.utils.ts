import { createHash } from 'node:crypto';

export function normalizePageText(text: string): string | null {
  const pageText = text.replace(/\s+/g, ' ').trim();
  return pageText || null;
}

export function splitPageText(text: string, maximumCharacters = 2800): string[] {
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

export function imagePagesFromListing(listing: string): number[] {
  const pages = new Set<number>();
  for (const line of listing.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+\d+\s+(?:image|smask|mask)\b/i);
    if (match) pages.add(Number(match[1]));
  }
  return [...pages].sort((left, right) => left - right);
}