import { AsyncLocalStorage } from 'node:async_hooks';

export interface TraceContext {
  traceId: string;
  requestId?: string;
  documentId?: string;
  jobId?: string;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

export function runWithTraceContext<T>(context: TraceContext, action: () => T): T {
  return traceStorage.run(context, action);
}

export function getTraceContext(): TraceContext | undefined {
  return traceStorage.getStore();
}
