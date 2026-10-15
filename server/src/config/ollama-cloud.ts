import { ServiceUnavailableException } from '@nestjs/common';
import { ChatOllama } from '@langchain/ollama';
import { getTraceContext } from '../observability/trace-context.js';

export const DEFAULT_OLLAMA_CHAT_MODEL = 'gemma4:31b';
export const DEFAULT_OLLAMA_VISION_MODEL = 'gemma4:31b';

export function ollamaCloudModelConfig(model: string) {
  const apiKey = process.env.OLLAMA_API_KEY?.trim();
  if (!apiKey) {
    throw new ServiceUnavailableException('OLLAMA_API_KEY is required for Ollama Cloud models.');
  }

  return {
    model,
    baseUrl: process.env.OLLAMA_CLOUD_BASE_URL?.trim() || 'https://ollama.com',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(getTraceContext()?.traceId ? { 'x-trace-id': getTraceContext()!.traceId } : {}),
      ...(getTraceContext()?.requestId ? { 'x-request-id': getTraceContext()!.requestId } : {}),
      ...(getTraceContext()?.documentId ? { 'x-document-id': getTraceContext()!.documentId } : {}),
      ...(getTraceContext()?.jobId ? { 'x-job-id': getTraceContext()!.jobId } : {}),
    },
    temperature: 0,
    maxRetries: 3,
  };
}

export function createOllamaCloudChatModel(): ChatOllama {
  return new ChatOllama(ollamaCloudModelConfig(
    process.env.OLLAMA_CLOUD_CHAT_MODEL?.trim() || DEFAULT_OLLAMA_CHAT_MODEL,
  ));
}

export function createOllamaCloudVisionModel(): ChatOllama {
  return new ChatOllama(ollamaCloudModelConfig(
    process.env.OLLAMA_CLOUD_VISION_MODEL?.trim() || DEFAULT_OLLAMA_VISION_MODEL,
  ));
}