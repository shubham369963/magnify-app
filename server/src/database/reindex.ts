import 'reflect-metadata';
import { Queue } from 'bullmq';
import { queueName, redisConnection } from '../config/settings.js';
import { SupabaseService } from './supabase.service.js';

interface ReindexDocument {
  id: string;
  project_id: string;
  owner_clerk_id: string;
}

async function reindexDocuments() {
  const supabase = new SupabaseService();
  const queue = new Queue(queueName, { connection: redisConnection() });
  let offset = 0;
  let queued = 0;
  const pageSize = 100;

  try {
    while (true) {
      const documents = await supabase.select<ReindexDocument>(
        'documents',
        new URLSearchParams({
          select: 'id,project_id,owner_clerk_id',
          order: 'id.asc',
          limit: String(pageSize),
          offset: String(offset),
        }),
      );
      for (const document of documents) {
        await queue.add('file-ready', {
          documentId: document.id,
          projectId: document.project_id,
          ownerId: document.owner_clerk_id,
        }, {
          jobId: `reindex-${document.id}-${Date.now()}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 1000,
          removeOnFail: 1000,
        });
        queued += 1;
      }
      if (documents.length < pageSize) break;
      offset += pageSize;
    }
    console.log(`Queued ${queued} PDF documents for reindexing.`);
  } finally {
    await queue.close();
  }
}

void reindexDocuments().catch((error: unknown) => {
  console.error('Could not queue PDF reindexing.', error);
  process.exitCode = 1;
});