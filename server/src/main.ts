import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module.js';
import { runWithTraceContext } from './observability/trace-context.js';

const logger = new Logger('ApiBootstrap');

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.use((request: Request, response: Response, next: NextFunction) => {
    const incomingTraceId = request.header('x-trace-id');
    const traceId = incomingTraceId && /^[0-9a-f-]{36}$/i.test(incomingTraceId)
      ? incomingTraceId
      : randomUUID();
    const requestId = randomUUID();
    response.setHeader('x-trace-id', traceId);
    response.setHeader('x-request-id', requestId);
    runWithTraceContext({ traceId, requestId }, next);
  });
  app.enableCors();
  app.enableShutdownHooks();
  const port = process.env.APP_PORT ?? 8000;
  await app.listen(port);
  logger.log(`APP is listening on port http://localhost:${port}`);
}

void bootstrap().catch((error: unknown) => {
  const detail = error instanceof Error ? error : new Error(String(error));
  logger.error('API startup failed.', detail.stack);
  process.exitCode = 1;
});