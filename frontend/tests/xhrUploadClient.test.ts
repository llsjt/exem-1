import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChunkUploadAbortedError,
  ChunkUploadNetworkError,
  XhrUploadClient,
  type ChunkUploadRequest
} from '../src/services/xhrUploadClient';

class MockXMLHttpRequest {
  static instances: MockXMLHttpRequest[] = [];

  method = '';
  url = '';
  status = 0;
  responseText = '';
  sentBody: Document | XMLHttpRequestBodyInit | null = null;
  abortCalled = false;
  upload: {
    onprogress: ((this: XMLHttpRequest, event: ProgressEvent) => void) | null;
  } = { onprogress: null };
  onload: ((event: ProgressEvent) => void) | null = null;
  onerror: ((event: ProgressEvent) => void) | null = null;
  onabort: ((event: ProgressEvent) => void) | null = null;

  constructor() {
    MockXMLHttpRequest.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  send(body?: Document | XMLHttpRequestBodyInit | null) {
    this.sentBody = body ?? null;
  }

  abort() {
    this.abortCalled = true;
    this.onabort?.(new ProgressEvent('abort'));
  }

  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.(new ProgressEvent('load'));
  }

  failNetwork() {
    this.onerror?.(new ProgressEvent('error'));
  }

  emitProgress(loaded: number, total: number) {
    this.upload.onprogress?.call(
      this as unknown as XMLHttpRequest,
      new ProgressEvent('progress', {
        lengthComputable: true,
        loaded,
        total
      })
    );
  }
}

const createUploadRequest = (overrides: Partial<ChunkUploadRequest> = {}): ChunkUploadRequest => ({
  fileHash: '0123456789abcdef0123456789abcdef',
  fileName: 'video.mp4',
  fileSize: 1024,
  chunkSize: 256,
  totalChunks: 4,
  chunkIndex: 1,
  mimeType: 'video/mp4',
  chunk: new Blob(['chunk-body'], { type: 'video/mp4' }),
  ...overrides
});

const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('XhrUploadClient', () => {
  beforeEach(() => {
    MockXMLHttpRequest.instances = [];
  });

  it('uploads one chunk with multipart fields through XMLHttpRequest', async () => {
    const client = new XhrUploadClient({
      XMLHttpRequestCtor: MockXMLHttpRequest as unknown as typeof XMLHttpRequest
    });
    const request = createUploadRequest();

    const upload = client.uploadChunk(request);
    const xhr = MockXMLHttpRequest.instances[0];
    const form = xhr.sentBody as FormData;

    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/uploads/chunks');
    expect(form.get('fileHash')).toBe(request.fileHash);
    expect(form.get('fileName')).toBe(request.fileName);
    expect(form.get('fileSize')).toBe(String(request.fileSize));
    expect(form.get('chunkSize')).toBe(String(request.chunkSize));
    expect(form.get('totalChunks')).toBe(String(request.totalChunks));
    expect(form.get('chunkIndex')).toBe(String(request.chunkIndex));
    expect(form.get('mimeType')).toBe(request.mimeType);
    expect(form.get('chunk')).toBeInstanceOf(Blob);

    xhr.respond(200, { chunkIndex: 1, uploaded: true });

    await expect(upload).resolves.toEqual({ chunkIndex: 1, uploaded: true });
  });

  it('reports upload progress from XMLHttpRequest.upload.onprogress', async () => {
    const onProgress = vi.fn();
    const client = new XhrUploadClient({
      XMLHttpRequestCtor: MockXMLHttpRequest as unknown as typeof XMLHttpRequest
    });

    const upload = client.uploadChunk(createUploadRequest(), { onProgress });
    const xhr = MockXMLHttpRequest.instances[0];

    xhr.emitProgress(128, 256);
    xhr.respond(200, { chunkIndex: 1, uploaded: true });
    await upload;

    expect(onProgress).toHaveBeenCalledWith({
      chunkIndex: 1,
      loaded: 128,
      total: 256,
      percent: 50
    });
  });

  it('aborts an active chunk request and clears it from the active request map', async () => {
    const client = new XhrUploadClient({
      XMLHttpRequestCtor: MockXMLHttpRequest as unknown as typeof XMLHttpRequest
    });

    const upload = client.uploadChunk(createUploadRequest());

    expect(client.hasActiveRequest(1)).toBe(true);
    expect(client.abortChunk(1)).toBe(true);

    await expect(upload).rejects.toBeInstanceOf(ChunkUploadAbortedError);
    expect(client.hasActiveRequest(1)).toBe(false);
    expect(client.activeCount).toBe(0);
    expect(MockXMLHttpRequest.instances[0].abortCalled).toBe(true);
    expect(MockXMLHttpRequest.instances).toHaveLength(1);
  });

  it('retries network failures at most two times for one chunk', async () => {
    const client = new XhrUploadClient({
      XMLHttpRequestCtor: MockXMLHttpRequest as unknown as typeof XMLHttpRequest
    });

    const upload = client.uploadChunk(createUploadRequest());

    MockXMLHttpRequest.instances[0].failNetwork();
    await flushMicrotasks();
    MockXMLHttpRequest.instances[1].failNetwork();
    await flushMicrotasks();
    MockXMLHttpRequest.instances[2].failNetwork();

    await expect(upload).rejects.toBeInstanceOf(ChunkUploadNetworkError);
    expect(MockXMLHttpRequest.instances).toHaveLength(3);
    expect(client.activeCount).toBe(0);
  });
});
