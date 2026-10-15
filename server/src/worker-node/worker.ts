import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';

const logger = new Logger('WorkerBootstrap');

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
}

void bootstrap().catch((error: unknown) => {
  const detail = error instanceof Error ? error : new Error(String(error));
  logger.error('Worker startup failed.', detail.stack);
  process.exitCode = 1;
});