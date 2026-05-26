export interface ChunkUploadRequest {
  fileHash: string;
  fileName: string;
  fileSize: number;
  chunkSize: number;
  totalChunks: number;
  chunkIndex: number;
  mimeType?: string;
  chunk: Blob;
}

export interface ChunkUploadResponse {
  chunkIndex: number;
  uploaded: boolean;
}

export interface ChunkUploadProgress {
  chunkIndex: number;
  loaded: number;
  total: number;
  percent: number;
}

export interface UploadChunkOptions {
  onProgress?: (progress: ChunkUploadProgress) => void;
}

export interface XhrUploadClientOptions {
  endpoint?: string;
  maxRetries?: number;
  XMLHttpRequestCtor?: typeof XMLHttpRequest;
}

export class ChunkUploadAbortedError extends Error {
  readonly chunkIndex: number;

  constructor(chunkIndex: number) {
    super(`Chunk ${chunkIndex} upload was aborted by the user`);
    this.name = 'ChunkUploadAbortedError';
    this.chunkIndex = chunkIndex;
  }
}

export class ChunkUploadNetworkError extends Error {
  readonly chunkIndex: number;

  constructor(chunkIndex: number, cause?: unknown) {
    super(`Chunk ${chunkIndex} upload failed because of a network error`);
    this.name = 'ChunkUploadNetworkError';
    this.chunkIndex = chunkIndex;
    this.cause = cause;
  }
}

export class ChunkUploadHttpError extends Error {
  readonly chunkIndex: number;
  readonly status: number;
  readonly responseText: string;

  constructor(chunkIndex: number, status: number, responseText: string) {
    super(`Chunk ${chunkIndex} upload failed with status ${status}`);
    this.name = 'ChunkUploadHttpError';
    this.chunkIndex = chunkIndex;
    this.status = status;
    this.responseText = responseText;
  }
}

export class XhrUploadClient {
  private readonly endpoint: string;
  private readonly maxRetries: number;
  private readonly XMLHttpRequestCtor: typeof XMLHttpRequest;
  private readonly activeRequests = new Map<number, XMLHttpRequest>();
  private readonly userAbortedChunks = new Set<number>();

  constructor(options: XhrUploadClientOptions = {}) {
    this.endpoint = options.endpoint ?? '/api/uploads/chunks';
    this.maxRetries = options.maxRetries ?? 2;
    this.XMLHttpRequestCtor = options.XMLHttpRequestCtor ?? XMLHttpRequest;
  }

  get activeCount(): number {
    return this.activeRequests.size;
  }

  hasActiveRequest(chunkIndex: number): boolean {
    return this.activeRequests.has(chunkIndex);
  }

  abortChunk(chunkIndex: number): boolean {
    const xhr = this.activeRequests.get(chunkIndex);

    if (!xhr) {
      return false;
    }

    // 主动暂停/取消会记录 chunkIndex，onabort 中据此区分用户操作和网络异常。
    this.userAbortedChunks.add(chunkIndex);
    xhr.abort();
    return true;
  }

  abortAll(): void {
    for (const chunkIndex of this.activeRequests.keys()) {
      this.abortChunk(chunkIndex);
    }
  }

  async uploadChunk(
    request: ChunkUploadRequest,
    options: UploadChunkOptions = {}
  ): Promise<ChunkUploadResponse> {
    this.userAbortedChunks.delete(request.chunkIndex);

    let lastError: unknown;

    // 单片最多重试 maxRetries 次；主动 abort 不重试，直接交给上层状态机处理。
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.uploadChunkOnce(request, options);
      } catch (error) {
        if (error instanceof ChunkUploadAbortedError) {
          throw error;
        }

        lastError = error;

        if (attempt >= this.maxRetries) {
          if (error instanceof ChunkUploadHttpError || error instanceof ChunkUploadNetworkError) {
            throw error;
          }

          throw new ChunkUploadNetworkError(request.chunkIndex, error);
        }
      }
    }

    throw new ChunkUploadNetworkError(request.chunkIndex, lastError);
  }

  private uploadChunkOnce(
    request: ChunkUploadRequest,
    options: UploadChunkOptions
  ): Promise<ChunkUploadResponse> {
    if (this.activeRequests.has(request.chunkIndex)) {
      return Promise.reject(new Error(`Chunk ${request.chunkIndex} is already uploading`));
    }

    const xhr = new this.XMLHttpRequestCtor();
    this.activeRequests.set(request.chunkIndex, xhr);

    return new Promise<ChunkUploadResponse>((resolve, reject) => {
      const cleanup = () => {
        // 请求结束后立即移出 Map，避免暂停/取消时操作到已完成的 XHR。
        if (this.activeRequests.get(request.chunkIndex) === xhr) {
          this.activeRequests.delete(request.chunkIndex);
        }
      };

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) {
          return;
        }

        // 真实上传进度只能从 XMLHttpRequest.upload.onprogress 读取。
        options.onProgress?.({
          chunkIndex: request.chunkIndex,
          loaded: event.loaded,
          total: event.total,
          percent: event.total === 0 ? 0 : (event.loaded / event.total) * 100
        });
      };

      xhr.onload = () => {
        cleanup();

        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new ChunkUploadHttpError(request.chunkIndex, xhr.status, xhr.responseText));
          return;
        }

        try {
          resolve(JSON.parse(xhr.responseText) as ChunkUploadResponse);
        } catch (error) {
          reject(new ChunkUploadNetworkError(request.chunkIndex, error));
        }
      };

      xhr.onerror = () => {
        cleanup();
        reject(new ChunkUploadNetworkError(request.chunkIndex));
      };

      xhr.onabort = () => {
        cleanup();

        // 浏览器 abort 事件既可能来自用户，也可能来自连接中断，这里保持语义区分。
        if (this.userAbortedChunks.has(request.chunkIndex)) {
          this.userAbortedChunks.delete(request.chunkIndex);
          reject(new ChunkUploadAbortedError(request.chunkIndex));
          return;
        }

        reject(new ChunkUploadNetworkError(request.chunkIndex));
      };

      xhr.open('POST', this.endpoint);
      xhr.send(toFormData(request));
    });
  }
}

function toFormData(request: ChunkUploadRequest): FormData {
  const form = new FormData();

  form.append('fileHash', request.fileHash);
  form.append('fileName', request.fileName);
  form.append('fileSize', String(request.fileSize));
  form.append('chunkSize', String(request.chunkSize));
  form.append('totalChunks', String(request.totalChunks));
  form.append('chunkIndex', String(request.chunkIndex));
  form.append('mimeType', request.mimeType ?? '');
  form.append('chunk', request.chunk, request.fileName);

  return form;
}
