import type { ApolloServerPlugin } from '@apollo/server';
import { Logger } from '@nestjs/common';
import { metrics, type GraphqlErrorPhase, type GraphqlOperationType } from './metrics.js';
import { getTraceContext } from './trace-context.js';

export function createGraphqlMetricsPlugin(logger = new Logger('GraphQL')): ApolloServerPlugin {
  const recordEarlyFailure = (phase: GraphqlErrorPhase, error: Error) => {
    const request = metrics.startGraphqlRequest();
    request.observeErrors('unknown', phase, 1);
    request.finish('unknown', 'error');
    logger.warn(JSON.stringify({
      event: 'graphql.request',
      status: 'error',
      operationType: 'unknown',
      phase,
      traceId: getTraceContext()?.traceId,
      requestId: getTraceContext()?.requestId,
      errorName: error.name,
    }));
  };

  return {
    async requestDidStart() {
      const startedAt = Date.now();
      const request = metrics.startGraphqlRequest();
      let operationType: GraphqlOperationType = 'unknown';
      let operationName = 'anonymous';
      let errorCount = 0;

      return {
        async didResolveOperation(context) {
          operationType = context.operation?.operation ?? 'unknown';
          operationName = context.operationName || 'anonymous';
        },
        async didEncounterErrors(context) {
          const phase: GraphqlErrorPhase = context.operation ? 'execution' : 'request';
          errorCount += context.errors.length;
          request.observeErrors(operationType, phase, context.errors.length);
        },
        async willSendResponse() {
          const outcome = errorCount > 0 ? 'error' : 'success';
          request.finish(operationType, outcome);
          const entry = {
            event: 'graphql.operation',
            status: outcome,
            operationType,
            operationName,
            durationMs: Date.now() - startedAt,
            errorCount,
            traceId: getTraceContext()?.traceId,
            requestId: getTraceContext()?.requestId,
          };
          if (outcome === 'error') logger.warn(JSON.stringify(entry));
          else logger.log(JSON.stringify(entry));
        },
      };
    },
    async invalidRequestWasReceived({ error }) {
      recordEarlyFailure('request', error);
    },
    async contextCreationDidFail({ error }) {
      recordEarlyFailure('request', error);
    },
    async unexpectedErrorProcessingRequest({ error }) {
      recordEarlyFailure('request', error);
    },
  };
}