export function formatDuration(durationMs: number): string {
  const milliseconds = Math.max(0, Math.round(durationMs));
  if (milliseconds < 1000) return `${milliseconds} ms`;

  const totalSeconds = milliseconds / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(totalSeconds < 10 ? 1 : 0)} s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
}