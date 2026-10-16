import { Inject, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import { PdfService } from '../document-service/pdf.service.js';
import type { ProjectTreeJobData, UploadJobData } from '../document-service/pdf.service.js';
import { queueName, redisConnection } from '../config/settings.js';
import { PdfProcessingModule } from '../document-service/pdf-processing.module.js';
import { createServer, type Server } from 'node:http';
import { metrics, type RagStrategy } from '../observability/metrics.js';
import { runWithTraceContext } from '../observability/trace-context.js';
import { randomUUID } from 'node:crypto';

@Injectable()
export class PdfWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PdfWorker.name);
  private worker?: Worker;
  private metricsServer?: Server;
  private workerReady = false;

  constructor(@Inject(PdfService) private readonly pdfService: PdfService) {}

  onModuleInit() {
    this.metricsServer = createServer((request, response) => {
      if (request.url === '/health') {
        const status = this.workerReady ? 200 : 503;
        response.writeHead(status, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ status: this.workerReady ? 'ready' : 'starting' }));
        return;
      }
      if (request.url !== '/metrics') {
        response.writeHead(404).end();
        return;
      }
      void metrics.registry.metrics().then((body) => {
        response.writeHead(200, { 'Content-Type': metrics.registry.contentType }).end(body);
      }).catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.error(`Could not render worker metrics: ${detail}`);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    this.metricsServer.on('error', (error) => this.logger.error(`Worker metrics server failed: ${error.message}`, error.stack));
    this.metricsServer.listen(Number(process.env.WORKER_METRICS_PORT || 9464), '0.0.0.0');

    this.worker = new Worker<UploadJobData | ProjectTreeJobData>(
      queueName,
      (job) => {
        const traceId = job.data.traceId ?? randomUUID();
        return runWithTraceContext({
          traceId,
          requestId: job.data.requestId,
          documentId: job.data.documentId,
          jobId: job.id,
        }, async () => {
        const strategy = this.jobStrategy(job.name);
        const event = {
          event: 'worker.job',
          jobId: job.id,
          requestId: job.data.requestId,
          documentId: job.data.documentId,
          projectId: job.data.projectId,
          traceId,
          strategy,
          attempt: job.attemptsMade + 1,
        };
        const result = job.name === 'project-index-tree'
          ? await this.pdfService.processProjectTree(job.data as ProjectTreeJobData, (progress) => job.updateProgress(progress))
          : await this.pdfService.process(job.data as UploadJobData, (progress) => job.updateProgress(progress));
        this.logger.log(JSON.stringify({ ...event, status: 'completed' }));
        return result;
        });
      },
      { concurrency: 4, connection: redisConnection() },
    );
    this.worker.on('ready', () => { this.workerReady = true; });
    this.worker.on('active', (job) => {
      const strategy = this.jobStrategy(job.name) as RagStrategy;
      metrics.observeWorkerActive(strategy, 1);
      metrics.observeWorkerAttempt(strategy, 'started');
      metrics.observeWorkerQueueWait(strategy, ((job.processedOn ?? Date.now()) - job.timestamp) / 1000);
    });
    this.worker.on('completed', (job) => {
      const strategy = this.jobStrategy(job.name) as RagStrategy;
      metrics.observeWorkerActive(strategy, -1);
      metrics.observeWorkerAttempt(strategy, 'success');
      metrics.observeWorkerJobDuration(strategy, 'success', ((job.finishedOn ?? Date.now()) - (job.processedOn ?? Date.now())) / 1000);
    });
    this.worker.on('failed', (job, error) => {
      if (!job) return;
      const strategy = this.jobStrategy(job.name);
      metrics.observeWorkerActive(strategy, -1);
      metrics.observeWorkerAttempt(strategy, 'error');
      metrics.observeWorkerJobDuration(strategy, 'error', ((Date.now()) - (job.processedOn ?? Date.now())) / 1000);
      const maximumAttempts = Number(job.opts.attempts ?? 1);
      if (job.attemptsMade < maximumAttempts) metrics.observeWorkerRetry(strategy);
      this.logger.error(JSON.stringify({
        event: 'worker.job.attempt',
        status: 'failed',
        jobId: job.id,
        documentId: job.data.documentId,
        projectId: job.data.projectId,
        traceId: job.data.traceId,
        strategy,
        attempt: job.attemptsMade,
        maximumAttempts,
        errorName: error.name,
        errorMessage: error.message.slice(0, 500),
      }));
      if (job.name === 'project-index-tree' && job.attemptsMade >= maximumAttempts) {
        void this.pdfService.markProjectTreeJobFailed(job.data as ProjectTreeJobData, error).catch((failure: unknown) => {
          const message = failure instanceof Error ? failure.message : String(failure);
          this.logger.error(`Could not finalize failed project index status: ${message}`);
        });
      }
    });
    this.worker.on('error', (error) => {
      this.workerReady = false;
      this.logger.error(`Worker encountered an error: ${error.message}`, error.stack);
    });
  }

  async onModuleDestroy() {
    this.workerReady = false;
    await Promise.all([
      this.worker?.close(),
      this.metricsServer
        ? new Promise<void>((resolve, reject) => this.metricsServer!.close((error) => error ? reject(error) : resolve()))
        : Promise.resolve(),
    ]);
  }

  private jobStrategy(jobName: string): RagStrategy {
    return jobName === 'project-index-tree' ? 'index_tree' : 'vector';
  }
}

@Module({ imports: [PdfProcessingModule], providers: [PdfWorker] })
export class WorkerModule {}