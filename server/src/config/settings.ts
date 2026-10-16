import { QdrantClient } from '@qdrant/js-client-rest';

export const queueName = 'file-upload-queue';
export const collectionName = 'langchainjs-testing';

export function redisConnection() {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    const parsedUrl = new URL(redisUrl);
    return {
      host: parsedUrl.hostname,
      port: Number(parsedUrl.port || 6379),
    };
  }
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT || 6380),
  };
}

export function createQdrantClient() {
  return new QdrantClient({
    url: process.env.QDRANT_URL || 'http://localhost:6333',
    apiKey: process.env.QDRANT_API_KEY || undefined,
    checkCompatibility: false,
  });
}

export async function deleteDocumentVectors(documentId: string): Promise<void> {
  try {
    const client = createQdrantClient();
    await ensureQdrantPayloadIndexes(client);
    await client.delete(collectionName, {
      filter: { must: [{ key: 'metadata.document_id', match: { value: documentId } }] },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const status = typeof error === 'object' && error !== null && 'status' in error
      ? Number(error.status)
      : undefined;
    if (status !== 404 && !/collection.*(not found|does not exist)|not found.*collection/i.test(detail)) {
      throw error;
    }
  }
}

export async function deleteUserVectors(ownerId: string): Promise<void> {
  try {
    const client = createQdrantClient();
    await ensureQdrantPayloadIndexes(client);
    await client.delete(collectionName, {
      filter: { must: [{ key: 'metadata.owner_clerk_id', match: { value: ownerId } }] },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const status = typeof error === 'object' && error !== null && 'status' in error
      ? Number(error.status)
      : undefined;
    if (status !== 404 && !/collection.*(not found|does not exist)|not found.*collection/i.test(detail)) {
      throw error;
    }
  }
}

export async function ensureQdrantPayloadIndexes(client: ReturnType<typeof createQdrantClient>): Promise<void> {
  const collection = await client.getCollection(collectionName);
  const existing = collection.payload_schema ?? {};
  for (const field of ['metadata.owner_clerk_id', 'metadata.project_id', 'metadata.document_id']) {
    if (existing[field]) continue;
    try {
      await client.createPayloadIndex(collectionName, {
        field_name: field,
        field_schema: 'keyword',
        wait: true,
      });
    } catch (error) {
      const status = typeof error === 'object' && error !== null && 'status' in error
        ? Number(error.status)
        : undefined;
      if (status !== 409) throw error;
    }
  }
}