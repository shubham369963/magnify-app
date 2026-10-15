export function pageSize(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.min(Math.max(Math.floor(value), 1), 100);
}