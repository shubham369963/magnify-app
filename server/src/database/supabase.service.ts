import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { metrics } from '../observability/metrics.js';
import { getTraceContext } from '../observability/trace-context.js';

@Injectable()
export class SupabaseService {
  private get config() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new ServiceUnavailableException('Supabase server configuration is incomplete.');
    }
    return { url: url.replace(/\/$/, ''), key };
  }

  private headers(extra?: HeadersInit): Headers {
    const { key } = this.config;
    const headers = new Headers(extra);
    const trace = getTraceContext();
    headers.set('apikey', key);
    headers.set('authorization', `Bearer ${key}`);
    if (trace?.traceId) headers.set('x-trace-id', trace.traceId);
    if (trace?.requestId) headers.set('x-request-id', trace.requestId);
    if (trace?.documentId) headers.set('x-document-id', trace.documentId);
    if (trace?.jobId) headers.set('x-job-id', trace.jobId);
    return headers;
  }

  async select<T>(table: string, query: URLSearchParams): Promise<T[]> {
    return this.request<T[]>(`/rest/v1/${table}?${query}`, { method: 'GET' });
  }

  async insert<T>(table: string, values: unknown, select = '*'): Promise<T[]> {
    return this.request<T[]>(`/rest/v1/${table}?select=${encodeURIComponent(select)}`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json', prefer: 'return=representation' }),
      body: JSON.stringify(values),
    });
  }

  async update<T>(table: string, query: URLSearchParams, values: unknown): Promise<T[]> {
    query.set('select', '*');
    return this.request<T[]>(`/rest/v1/${table}?${query}`, {
      method: 'PATCH',
      headers: this.headers({ 'content-type': 'application/json', prefer: 'return=representation' }),
      body: JSON.stringify(values),
    });
  }

  async delete(table: string, query: URLSearchParams): Promise<void> {
    await this.request<unknown>(`/rest/v1/${table}?${query}`, { method: 'DELETE' });
  }

  async rpc<T>(functionName: string, values: unknown): Promise<T> {
    return this.request<T>(`/rest/v1/rpc/${encodeURIComponent(functionName)}`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(values),
    });
  }

  async uploadObject(path: string, file: Buffer, contentType: string): Promise<void> {
    const bucket = encodeURIComponent(process.env.SUPABASE_STORAGE_BUCKET || 'documents');
    await this.storageRequest(`/object/${bucket}/${this.encodePath(path)}`, {
      method: 'POST',
      headers: this.headers({ 'content-type': contentType, 'x-upsert': 'false' }),
      body: file as unknown as BodyInit,
    });
  }

  async downloadObject(path: string): Promise<Buffer> {
    const bucket = encodeURIComponent(process.env.SUPABASE_STORAGE_BUCKET || 'documents');
    const response = await this.storageRequest(`/object/${bucket}/${this.encodePath(path)}`, { method: 'GET' });
    const file = Buffer.from(await response.arrayBuffer());
    metrics.observeDependencyPayload('supabase_storage', 'download', 'response', file.byteLength);
    return file;
  }

  async createSignedObjectUrl(path: string, expiresIn = 600): Promise<string> {
    const bucket = encodeURIComponent(process.env.SUPABASE_STORAGE_BUCKET || 'documents');
    const response = await this.storageRequest(`/object/sign/${bucket}/${this.encodePath(path)}`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ expiresIn }),
    });
    if (!response.ok) {
      const details = await response.text().catch(() => '');
      throw new Error(`Supabase Storage signing failed (${response.status}): ${details.slice(0, 300)}`);
    }
    const body = await response.json() as { signedURL?: unknown };
    if (typeof body.signedURL !== 'string') throw new Error('Supabase Storage did not return a signed URL.');
    if (/^https?:\/\//i.test(body.signedURL)) return body.signedURL;
    const signedPath = body.signedURL.startsWith('/') ? body.signedURL : `/${body.signedURL}`;
    return `${this.config.url}/storage/v1${signedPath}`;
  }

  async deleteObject(path: string): Promise<void> {
    const bucket = encodeURIComponent(process.env.SUPABASE_STORAGE_BUCKET || 'documents');
    await this.storageRequest(`/object/${bucket}`, {
      method: 'DELETE',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ prefixes: [path] }),
    });
  }

  private async storageRequest(path: string, init: RequestInit): Promise<Response> {
    const operation = path.startsWith('/object/sign/') ? 'sign' : init.method === 'POST' ? 'upload' : init.method === 'DELETE' ? 'delete' : 'download';
    const requestBytes = payloadByteLength(init.body);
    const finish = metrics.startDependency('supabase_storage', operation, requestBytes);
    try {
      const response = await fetch(`${this.config.url}/storage/v1${path}`, {
        ...init,
        headers: this.headers(init.headers),
      });
      const responseBytes = operation === 'download' ? 0 : Number(response.headers.get('content-length')) || 0;
      if (!response.ok) {
        await response.text().catch(() => '');
        throw new Error(`Supabase Storage request failed (${response.status}).`);
      }
      finish('success', responseBytes);
      return response;
    } catch (error) {
      finish('error');
      metrics.logDependencyFailure('supabase_storage', operation, error);
      throw error;
    }
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const operation = dependencyOperation(path);
    const finish = metrics.startDependency('supabase_db', operation, payloadByteLength(init.body));
    try {
      const response = await fetch(`${this.config.url}${path}`, {
        ...init,
        headers: this.headers(init.headers),
      });
      if (!response.ok) {
        await response.text().catch(() => '');
        throw new Error(`Supabase database request failed (${response.status}).`);
      }
      if (response.status === 204) {
        finish('success');
        return undefined as T;
      }
      const responseBytes = Number(response.headers.get('content-length')) || 0;
      const result = await response.json() as T;
      finish('success', responseBytes);
      return result;
    } catch (error) {
      finish('error');
      metrics.logDependencyFailure('supabase_db', operation, error);
      throw error;
    }
  }

  private encodePath(path: string): string {
    return path.split('/').map(encodeURIComponent).join('/');
  }
}

function dependencyOperation(path: string): string {
  const match = path.match(/^\/rest\/v1\/(?:rpc\/)?([^/?]+)/);
  return match?.[1] ?? 'unknown';
}

function payloadByteLength(body: BodyInit | null | undefined): number {
  if (body === null || body === undefined) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (Buffer.isBuffer(body)) return body.byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return 0;
}