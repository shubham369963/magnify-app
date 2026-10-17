export function initialQueueWaitSeconds(
  job: { timestamp: number; processedOn?: number; attemptsMade: number; attemptsStarted?: number; stalledCounter?: number },
  now = Date.now(),
): number | undefined {
  // BullMQ retains the initial enqueue timestamp across retries and stalled-job recovery.
  if (job.attemptsMade > 0 || (job.attemptsStarted ?? 1) > 1 || (job.stalledCounter ?? 0) > 0) return undefined;
  return ((job.processedOn ?? now) - job.timestamp) / 1000;
}
