export interface UploadFileMetadata {
  fileHash: string;
  fileName: string;
  fileSize: number;
  mimeType?: string;
}

export interface CheckUploadRequest extends UploadFileMetadata {
  chunkSize: number;
  totalChunks: number;
}

export interface CheckUploadResponse {
  exists: boolean;
  uploadedChunks: number[];
  fileUrl: string | null;
}

export type UploadStatus = 'UPLOADING' | 'MERGING' | 'MERGED' | 'NOT_FOUND';

export interface UploadStatusResponse {
  fileHash: string;
  status: UploadStatus;
  uploadedChunks: number[];
}

export interface MergeUploadRequest extends UploadFileMetadata {
  totalChunks: number;
}

export interface MergeUploadResponse extends UploadFileMetadata {
  status: 'MERGED';
  fileUrl: string;
}

export interface DeleteUploadResponse {
  fileHash: string;
  canceled: true;
}

export interface UploadApiErrorBody {
  code?: string;
  message?: string;
  details?: unknown;
}

export interface UploadApiOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class UploadApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(status: number, body: UploadApiErrorBody = {}) {
    super(body.message ?? `Upload API request failed with status ${status}`);
    this.name = 'UploadApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details;
  }
}

export async function checkUpload(
  payload: CheckUploadRequest,
  options?: UploadApiOptions
): Promise<CheckUploadResponse> {
  return requestJson<CheckUploadResponse>('/api/uploads/check', {
    method: 'POST',
    body: payload
  }, options);
}

export async function getUploadStatus(
  fileHash: string,
  options?: UploadApiOptions
): Promise<UploadStatusResponse> {
  return requestJson<UploadStatusResponse>(`/api/uploads/${encodeURIComponent(fileHash)}/status`, {
    method: 'GET'
  }, options);
}

export async function mergeUpload(
  payload: MergeUploadRequest,
  options?: UploadApiOptions
): Promise<MergeUploadResponse> {
  return requestJson<MergeUploadResponse>('/api/uploads/merge', {
    method: 'POST',
    body: payload
  }, options);
}

export async function deleteUpload(
  fileHash: string,
  options?: UploadApiOptions
): Promise<DeleteUploadResponse> {
  return requestJson<DeleteUploadResponse>(`/api/uploads/${encodeURIComponent(fileHash)}`, {
    method: 'DELETE'
  }, options);
}

interface JsonRequestInit {
  method: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
}

async function requestJson<T>(path: string, init: JsonRequestInit, options?: UploadApiOptions): Promise<T> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const url = `${options?.baseUrl?.replace(/\/$/, '') ?? ''}${path}`;
  const requestInit: RequestInit = init.body === undefined
    ? {
        method: init.method,
        headers: { Accept: 'application/json' }
      }
    : {
        method: init.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(init.body)
      };

  const response = await fetchImpl(url, requestInit);
  const data = await readJson(response);

  if (!response.ok) {
    throw new UploadApiError(response.status, data as UploadApiErrorBody);
  }

  return data as T;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
