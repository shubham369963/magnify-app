import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  createOllamaCloudChatModel,
  createOllamaCloudVisionModel,
  DEFAULT_OLLAMA_CHAT_MODEL,
  DEFAULT_OLLAMA_VISION_MODEL,
  ollamaCloudModelConfig,
} from '../../dist/config/ollama-cloud.js';

test('Ollama Cloud chat and vision models use configured model IDs', () => {
  const previous = {
    apiKey: process.env.OLLAMA_API_KEY,
    chatModel: process.env.OLLAMA_CLOUD_CHAT_MODEL,
    visionModel: process.env.OLLAMA_CLOUD_VISION_MODEL,
  };
  process.env.OLLAMA_API_KEY = 'test-only-key';
  process.env.OLLAMA_CLOUD_CHAT_MODEL = 'chat-test';
  process.env.OLLAMA_CLOUD_VISION_MODEL = 'vision-test';
  try {
    assert.equal(createOllamaCloudChatModel().model, 'chat-test');
    assert.equal(createOllamaCloudVisionModel().model, 'vision-test');
  } finally {
    if (previous.apiKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = previous.apiKey;
    if (previous.chatModel === undefined) delete process.env.OLLAMA_CLOUD_CHAT_MODEL;
    else process.env.OLLAMA_CLOUD_CHAT_MODEL = previous.chatModel;
    if (previous.visionModel === undefined) delete process.env.OLLAMA_CLOUD_VISION_MODEL;
    else process.env.OLLAMA_CLOUD_VISION_MODEL = previous.visionModel;
  }
});

test('Ollama Cloud models default to gemma4:31b', () => {
  const previous = {
    apiKey: process.env.OLLAMA_API_KEY,
    chatModel: process.env.OLLAMA_CLOUD_CHAT_MODEL,
    visionModel: process.env.OLLAMA_CLOUD_VISION_MODEL,
  };
  process.env.OLLAMA_API_KEY = 'test-only-key';
  delete process.env.OLLAMA_CLOUD_CHAT_MODEL;
  delete process.env.OLLAMA_CLOUD_VISION_MODEL;
  try {
    assert.equal(createOllamaCloudChatModel().model, DEFAULT_OLLAMA_CHAT_MODEL);
    assert.equal(createOllamaCloudVisionModel().model, DEFAULT_OLLAMA_VISION_MODEL);
  } finally {
    if (previous.apiKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = previous.apiKey;
    if (previous.chatModel === undefined) delete process.env.OLLAMA_CLOUD_CHAT_MODEL;
    else process.env.OLLAMA_CLOUD_CHAT_MODEL = previous.chatModel;
    if (previous.visionModel === undefined) delete process.env.OLLAMA_CLOUD_VISION_MODEL;
    else process.env.OLLAMA_CLOUD_VISION_MODEL = previous.visionModel;
  }
});

test('Ollama Cloud config uses the hosted endpoint and bearer key', () => {
  const previous = {
    apiKey: process.env.OLLAMA_API_KEY,
    baseUrl: process.env.OLLAMA_CLOUD_BASE_URL,
  };
  process.env.OLLAMA_API_KEY = 'test-only-key';
  delete process.env.OLLAMA_CLOUD_BASE_URL;
  try {
    const config = ollamaCloudModelConfig('chat-test');
    assert.equal(config.baseUrl, 'https://ollama.com');
    assert.equal(config.headers.Authorization, 'Bearer test-only-key');
  } finally {
    if (previous.apiKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = previous.apiKey;
    if (previous.baseUrl === undefined) delete process.env.OLLAMA_CLOUD_BASE_URL;
    else process.env.OLLAMA_CLOUD_BASE_URL = previous.baseUrl;
  }
});

test('Ollama Cloud model factories require an API key', () => {
  const previous = process.env.OLLAMA_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  try {
    assert.throws(createOllamaCloudChatModel, ServiceUnavailableException);
    assert.throws(createOllamaCloudVisionModel, ServiceUnavailableException);
  } finally {
    if (previous !== undefined) process.env.OLLAMA_API_KEY = previous;
  }
});