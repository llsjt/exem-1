import path from 'node:path';

export interface UploadConfig {
  storageRoot: string;
  chunksRoot: string;
  filesRoot: string;
  chunkSize: number;
  chunkExpireHours: number;
  cleanupCron: string;
  maxChunkSize: number;
}

export interface UploadConfigInput {
  storageRoot?: string;
  chunkSize?: number;
  chunkExpireHours?: number;
  cleanupCron?: string;
  maxChunkSize?: number;
}

const DEFAULT_STORAGE_ROOT = 'storage';
const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;
const DEFAULT_CHUNK_EXPIRE_HOURS = 24;
const DEFAULT_CLEANUP_CRON = '*/30 * * * *';
const DEFAULT_MAX_CHUNK_SIZE = 10 * 1024 * 1024;

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function createUploadConfig(input: UploadConfigInput = {}): UploadConfig {
  const storageRoot = path.resolve(input.storageRoot ?? process.env.UPLOAD_STORAGE_ROOT ?? DEFAULT_STORAGE_ROOT);

  return {
    storageRoot,
    chunksRoot: path.join(storageRoot, 'chunks'),
    filesRoot: path.join(storageRoot, 'files'),
    chunkSize: input.chunkSize ?? readPositiveInteger(process.env.UPLOAD_CHUNK_SIZE, DEFAULT_CHUNK_SIZE),
    chunkExpireHours:
      input.chunkExpireHours ?? readPositiveInteger(process.env.UPLOAD_CHUNK_EXPIRE_HOURS, DEFAULT_CHUNK_EXPIRE_HOURS),
    cleanupCron: input.cleanupCron ?? process.env.UPLOAD_CLEANUP_CRON ?? DEFAULT_CLEANUP_CRON,
    maxChunkSize: input.maxChunkSize ?? readPositiveInteger(process.env.UPLOAD_MAX_CHUNK_SIZE, DEFAULT_MAX_CHUNK_SIZE)
  };
}

export const uploadConfig = createUploadConfig();
