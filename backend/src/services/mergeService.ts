import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { AppError } from '../types/errorTypes.js';
import type { MergedFileMeta, UploadMeta } from '../types/uploadTypes.js';
import { uploadLockManager, type LockManager } from '../storage/lockManager.js';
import { storageService, type StorageService } from '../storage/storageService.js';

export interface MergeInput {
  fileHash: unknown;
  fileName: unknown;
  fileSize: unknown;
  totalChunks: unknown;
  mimeType?: unknown;
}

export interface MergeResult {
  fileHash: string;
  fileName: string;
  fileSize: number;
  status: 'MERGED';
  fileUrl: string;
}

export interface MergeService {
  mergeUpload(input: MergeInput): Promise<MergeResult>;
}

interface ValidatedMergeInput {
  fileHash: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  mimeType?: string;
}

function validateRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError(400, 'INVALID_ARGUMENT', `${fieldName} is required`, { [fieldName]: value });
  }

  return value;
}

function validatePositiveInteger(value: unknown, fieldName: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new AppError(400, 'INVALID_ARGUMENT', `${fieldName} must be a positive integer`, { [fieldName]: value });
  }

  return value as number;
}

function validateInput(input: MergeInput, storage: StorageService): ValidatedMergeInput {
  const fileHash = validateRequiredString(input.fileHash, 'fileHash');

  if (!storage.isValidFileHash(fileHash)) {
    throw new AppError(400, 'INVALID_FILE_HASH', 'Invalid fileHash', { fileHash });
  }

  const mimeType = input.mimeType === undefined ? undefined : validateRequiredString(input.mimeType, 'mimeType');

  return {
    fileHash,
    fileName: validateRequiredString(input.fileName, 'fileName'),
    fileSize: validatePositiveInteger(input.fileSize, 'fileSize'),
    totalChunks: validatePositiveInteger(input.totalChunks, 'totalChunks'),
    mimeType
  };
}

function hasMetaConflict(input: ValidatedMergeInput, meta: UploadMeta): boolean {
  return (
    meta.fileHash !== input.fileHash ||
    meta.fileName !== input.fileName ||
    meta.fileSize !== input.fileSize ||
    meta.totalChunks !== input.totalChunks ||
    meta.mimeType !== input.mimeType
  );
}

function resultFromMeta(meta: MergedFileMeta): MergeResult {
  return {
    fileHash: meta.fileHash,
    fileName: meta.fileName,
    fileSize: meta.fileSize,
    status: 'MERGED',
    fileUrl: meta.fileUrl
  };
}

function resultFromInput(input: ValidatedMergeInput): MergeResult {
  return {
    fileHash: input.fileHash,
    fileName: input.fileName,
    fileSize: input.fileSize,
    status: 'MERGED',
    fileUrl: `/api/files/${input.fileHash}`
  };
}

async function readMergedResultIfExists(input: ValidatedMergeInput, storage: StorageService): Promise<MergeResult | null> {
  if (!(await storage.mergedFileExists(input.fileHash))) {
    return null;
  }

  try {
    return resultFromMeta(await storage.readMergedFileMeta(input.fileHash));
  } catch (error) {
    if (error instanceof AppError && error.code === 'FILE_NOT_FOUND') {
      return resultFromInput(input);
    }

    throw error;
  }
}

async function assertAllChunksExist(input: ValidatedMergeInput, storage: StorageService): Promise<void> {
  for (let chunkIndex = 0; chunkIndex < input.totalChunks; chunkIndex += 1) {
    if (!(await storage.chunkExists(input.fileHash, chunkIndex))) {
      throw new AppError(400, 'MISSING_CHUNK', `Missing chunk ${chunkIndex}`, {
        fileHash: input.fileHash,
        chunkIndex
      });
    }
  }
}

async function writeChunksToTempFile(input: ValidatedMergeInput, storage: StorageService): Promise<void> {
  const tempFilePath = storage.getTempMergedFilePath(input.fileHash);
  const output = createWriteStream(tempFilePath, { flags: 'w' });

  try {
    for (let chunkIndex = 0; chunkIndex < input.totalChunks; chunkIndex += 1) {
      const inputStream = createReadStream(storage.getChunkPath(input.fileHash, chunkIndex));

      for await (const chunk of inputStream) {
        if (!output.write(chunk)) {
          await once(output, 'drain');
        }
      }
    }

    output.end();
    await once(output, 'finish');
  } catch (error) {
    output.destroy();
    throw error;
  }
}

export function createMergeService(
  storage: StorageService = storageService,
  lockManager: LockManager = uploadLockManager
): MergeService {
  return {
    async mergeUpload(rawInput) {
      const input = validateInput(rawInput, storage);
      const existingResult = await readMergedResultIfExists(input, storage);

      if (existingResult) {
        return existingResult;
      }

      if (lockManager.isLocked(input.fileHash)) {
        const mergedWhileWaiting = await readMergedResultIfExists(input, storage);

        if (mergedWhileWaiting) {
          return mergedWhileWaiting;
        }

        throw new AppError(409, 'MERGE_IN_PROGRESS', 'merge is already in progress', { fileHash: input.fileHash });
      }

      const release = await lockManager.acquire(input.fileHash);

      try {
        const mergedAfterLock = await readMergedResultIfExists(input, storage);

        if (mergedAfterLock) {
          return mergedAfterLock;
        }

        const uploadMeta = await storage.readUploadMeta(input.fileHash);

        if (hasMetaConflict(input, uploadMeta)) {
          throw new AppError(400, 'META_CONFLICT', 'merge metadata conflicts with upload metadata', {
            fileHash: input.fileHash
          });
        }

        await assertAllChunksExist(input, storage);
        await storage.updateUploadMeta(input.fileHash, (current) => ({
          ...current,
          status: 'MERGING',
          updatedAt: new Date().toISOString()
        }));
        await storage.ensureFileDir(input.fileHash);

        try {
          await rm(storage.getTempMergedFilePath(input.fileHash), { force: true });
          await writeChunksToTempFile(input, storage);
          await rename(storage.getTempMergedFilePath(input.fileHash), storage.getMergedFilePath(input.fileHash));

          const completedAt = new Date().toISOString();
          await storage.writeMergedFileMeta({
            fileHash: input.fileHash,
            fileName: input.fileName,
            fileSize: input.fileSize,
            mimeType: input.mimeType,
            schemaVersion: 1,
            status: 'MERGED',
            fileUrl: `/api/files/${input.fileHash}`,
            completedAt
          });
          await rm(storage.getChunkDir(input.fileHash), { recursive: true, force: true });

          return resultFromInput(input);
        } catch (error) {
          await rm(storage.getTempMergedFilePath(input.fileHash), { force: true });
          throw error;
        }
      } finally {
        release();
      }
    }
  };
}

export const mergeService = createMergeService();
