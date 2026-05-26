export type UploadStatus = 'UPLOADING' | 'MERGING' | 'MERGED' | 'NOT_FOUND';

export interface UploadMeta {
  fileHash: string;
  fileName: string;
  fileSize: number;
  chunkSize: number;
  totalChunks: number;
  mimeType?: string;
  schemaVersion: 1;
  status: Exclude<UploadStatus, 'NOT_FOUND'>;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
}

export interface MergedFileMeta {
  fileHash: string;
  fileName: string;
  fileSize: number;
  mimeType?: string;
  schemaVersion: 1;
  status: 'MERGED';
  fileUrl: string;
  completedAt: string;
}

export interface ChunkWriteParams {
  fileHash: string;
  chunkIndex: number;
  data: string | Uint8Array;
}

export interface ChunkWriteResult {
  chunkIndex: number;
  uploaded: true;
  skipped: boolean;
}
