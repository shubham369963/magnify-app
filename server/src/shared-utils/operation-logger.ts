import { HttpException, Logger } from '@nestjs/common';
import { getTraceContext } from '../observability/trace-context.js';

export type OperationLogDetails = Record<string, string | number | boolean | null | undefined>;

export async function withOperationLog<T>(
  logger: Logger,
  operation: string,
  details: OperationLogDetails,
  action: () => Promise<T>,
  resultDetails?: (result: T) => OperationLogDetails,
): Promise<T> {
  const startedAt = Date.now();
  const trace = getTraceContext();
  const context = {
    traceId: trace?.traceId,
    requestId: trace?.requestId,
    documentId: trace?.documentId,
    jobId: trace?.jobId,
  };
  logger.log(JSON.stringify({ event: operation, status: 'started', ...context, ...details }));

  try {
    const result = await action();
    logger.log(JSON.stringify({
      event: operation,
      status: 'completed',
      ...context,
      ...details,
      ...resultDetails?.(result),
      durationMs: Date.now() - startedAt,
    }));
    return result;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (error instanceof HttpException && error.getStatus() < 500) {
      logger.warn(JSON.stringify({ event: operation, status: 'rejected', ...context, ...details, httpStatus: error.getStatus() }));
    } else {
      logger.error(JSON.stringify({
        event: operation,
        status: 'failed',
        ...context,
        ...details,
        durationMs: Date.now() - startedAt,
        errorName: failure.name,
      }));
    }
    throw error;
  }
}