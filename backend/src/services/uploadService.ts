import { readFile, rm, unlink } from 'node:fs/promises';
import { AppError } from '../types/errorTypes.js';
import type { ChunkWriteResult } from '../types/uploadTypes.js';

export type UploadStatus = 'NOT_FOUND' | 'UPLOADING' | 'MERGING' | 'MERGED';

export interface UploadCheckInput {
  fileHash: unknown;
  fileName?: unknown;
  fileSize: unknown;
  chunkSize: unknown;
  totalChunks: unknown;
  mimeType?: unknown;
}

export interface UploadCheckResult {
  exists: boolean;
  uploadedChunks: number[];
  fileUrl: string | null;
}

export interface UploadStatusResult {
  fileHash: string;
  status: UploadStatus;
  uploadedChunks: number[];
  fileUrl: string | null;
}

export interface UploadChunkInput {
  fileHash: unknown;
  fileName: unknown;
  fileSize: unknown;
  chunkSize: unknown;
  totalChunks: unknown;
  chunkIndex: unknown;
  mimeType: unknown;
  chunk?: Express.Multer.File;
}

export interface UploadChunkResult {
  chunkIndex: number;
  uploaded: true;
}

export interface MergedFileInfo {
  fileUrl: string;
}

export interface CancelUploadResult {
  fileHash: string;
  canceled: true;
}

export interface UploadMeta {
  status?: UploadStatus;
  fileHash?: string;
  fileName?: string;
  fileSize?: number;
  chunkSize?: number;
  totalChunks?: number;
  mimeType?: string;
  schemaVersion?: 1;
  createdAt?: string;
  updatedAt?: string;
  lastAccessedAt?: string;
}

export interface UploadStorageService {
  findMergedFile(fileHash: string): Promise<MergedFileInfo | null>;
  listUploadedChunks(fileHash: string): Promise<number[]>;
  readUploadMeta(fileHash: string): Promise<UploadMeta | null>;
  touchUploadMeta(fileHash: string, accessedAt: string): Promise<void>;
  writeUploadMeta?(meta: UploadMeta): Promise<void>;
  writeChunk?(params: { fileHash: string; chunkIndex: number; data: Uint8Array }): Promise<ChunkWriteResult>;
  deleteChunkDir?(fileHash: string): Promise<void>;
}

export interface FilesystemStorageService {
  mergedFileExists(fileHash: string): Promise<boolean>;
  readMergedFileMeta(fileHash: string): Promise<MergedFileInfo>;
  scanUploadedChunks(fileHash: string): Promise<number[]>;
  readUploadMeta(fileHash: string): Promise<UploadMeta>;
  writeUploadMeta?(meta: UploadMeta): Promise<void>;
  updateUploadMeta(fileHash: string, updater: (current: UploadMeta) => UploadMeta | Promise<UploadMeta>): Promise<UploadMeta>;
  writeChunk?(params: { fileHash: string; chunkIndex: number; data: Uint8Array }): Promise<ChunkWriteResult>;
  getChunkDir?(fileHash: string): string;
}

export interface UploadService {
  checkUpload(input: UploadCheckInput): Promise<UploadCheckResult>;
  uploadChunk(input: UploadChunkInput): Promise<UploadChunkResult>;
  getUploadStatus(fileHash: unknown): Promise<UploadStatusResult>;
  cancelUpload(fileHash: unknown): Promise<CancelUploadResult>;
}

const fileHashPattern = /^[a-fA-F0-9]{32}$/;
const storageModulePath = '../storage/storageService.js';

function validateFileHash(fileHash: unknown): string {
  if (typeof fileHash !== 'string' || !fileHashPattern.test(fileHash)) {
    throw new AppError(400, 'INVALID_FILE_HASH', 'Invalid fileHash', { fileHash });
  }

  return fileHash;
}

function validatePositiveInteger(value: unknown, fieldName: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new AppError(400, 'INVALID_ARGUMENT', `${fieldName} must be a positive integer`, { [fieldName]: value });
  }

  return value as number;
}

function validateMultipartInteger(value: unknown, fieldName: string): number {
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return validatePositiveInteger(Number(value), fieldName);
  }

  return validatePositiveInteger(value, fieldName);
}

function validateMultipartNonNegativeInteger(value: unknown, fieldName: string): number {
  const parsedValue = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

  if (!Number.isInteger(parsedValue) || (parsedValue as number) < 0) {
    throw new AppError(400, 'INVALID_ARGUMENT', `${fieldName} must be a non-negative integer`, { [fieldName]: value });
  }

  return parsedValue as number;
}

function validateRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError(400, 'INVALID_ARGUMENT', `${fieldName} is required`, { [fieldName]: value });
  }

  return value;
}

function validateCheckInput(input: UploadCheckInput) {
  const fileHash = validateFileHash(input.fileHash);
  const fileSize = validatePositiveInteger(input.fileSize, 'fileSize');
  const chunkSize = validatePositiveInteger(input.chunkSize, 'chunkSize');
  const totalChunks = validatePositiveInteger(input.totalChunks, 'totalChunks');
  const expectedTotalChunks = Math.ceil(fileSize / chunkSize);

  // totalChunks 必须能由 fileSize/chunkSize 推导出来，防止前后端对分片数量理解不一致。
  if (totalChunks !== expectedTotalChunks) {
    throw new AppError(400, 'INVALID_ARGUMENT', 'totalChunks does not match fileSize and chunkSize', {
      fileSize,
      chunkSize,
      totalChunks,
      expectedTotalChunks
    });
  }

  return { fileHash, fileSize, chunkSize, totalChunks };
}

function validateChunkInput(input: UploadChunkInput) {
  const fileHash = validateFileHash(input.fileHash);
  const fileName = validateRequiredString(input.fileName, 'fileName');
  const mimeType = validateRequiredString(input.mimeType, 'mimeType');
  const fileSize = validateMultipartInteger(input.fileSize, 'fileSize');
  const chunkSize = validateMultipartInteger(input.chunkSize, 'chunkSize');
  const totalChunks = validateMultipartInteger(input.totalChunks, 'totalChunks');
  const chunkIndex = validateMultipartNonNegativeInteger(input.chunkIndex, 'chunkIndex');
  const expectedTotalChunks = Math.ceil(fileSize / chunkSize);

  if (totalChunks !== expectedTotalChunks) {
    throw new AppError(400, 'INVALID_ARGUMENT', 'totalChunks does not match fileSize and chunkSize', {
      fileSize,
      chunkSize,
      totalChunks,
      expectedTotalChunks
    });
  }

  if (chunkIndex >= totalChunks) {
    throw new AppError(400, 'INVALID_ARGUMENT', 'chunkIndex must be less than totalChunks', {
      chunkIndex,
      totalChunks
    });
  }

  if (!input.chunk) {
    throw new AppError(400, 'INVALID_ARGUMENT', 'chunk is required');
  }

  const actualChunkSize = input.chunk.size;
  const isLastChunk = chunkIndex === totalChunks - 1;

  // 除最后一片外，分片大小必须固定；最后一片允许不足 chunkSize。
  if (!isLastChunk && actualChunkSize !== chunkSize) {
    throw new AppError(400, 'INVALID_ARGUMENT', 'chunk size must equal chunkSize for non-final chunks', {
      chunkIndex,
      chunkSize,
      actualChunkSize
    });
  }

  if (isLastChunk && actualChunkSize > chunkSize) {
    throw new AppError(400, 'INVALID_ARGUMENT', 'final chunk size must be less than or equal to chunkSize', {
      chunkIndex,
      chunkSize,
      actualChunkSize
    });
  }

  return {
    fileHash,
    fileName,
    fileSize,
    chunkSize,
    totalChunks,
    chunkIndex,
    mimeType,
    chunk: input.chunk
  };
}

function assertUploadStorage(storageService: UploadStorageService): asserts storageService is UploadStorageService &
  Required<Pick<UploadStorageService, 'writeUploadMeta' | 'writeChunk' | 'deleteChunkDir'>> {
  if (!storageService.writeUploadMeta || !storageService.writeChunk) {
    throw new AppError(500, 'STORAGE_ERROR', 'storage service does not support chunk writes');
  }
}

function createUploadMeta(input: ReturnType<typeof validateChunkInput>, now: string): UploadMeta {
  return {
    fileHash: input.fileHash,
    fileName: input.fileName,
    fileSize: input.fileSize,
    chunkSize: input.chunkSize,
    totalChunks: input.totalChunks,
    mimeType: input.mimeType,
    schemaVersion: 1,
    status: 'UPLOADING',
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now
  };
}

function hasMetaConflict(existingMeta: UploadMeta, incomingMeta: UploadMeta): boolean {
  // 同一个 fileHash 下的基础元信息必须稳定，否则会把不同文件的分片混在同一目录。
  return (
    existingMeta.fileHash !== incomingMeta.fileHash ||
    existingMeta.fileName !== incomingMeta.fileName ||
    existingMeta.fileSize !== incomingMeta.fileSize ||
    existingMeta.chunkSize !== incomingMeta.chunkSize ||
    existingMeta.totalChunks !== incomingMeta.totalChunks ||
    existingMeta.mimeType !== incomingMeta.mimeType
  );
}

function sortChunkIndexes(chunkIndexes: number[]): number[] {
  return [...chunkIndexes]
    .filter((chunkIndex) => Number.isInteger(chunkIndex) && chunkIndex >= 0)
    .sort((left, right) => left - right);
}

function hasExpectedStorageContract(storageService: unknown): storageService is UploadStorageService {
  return (
    typeof storageService === 'object' &&
    storageService !== null &&
    'findMergedFile' in storageService &&
    'listUploadedChunks' in storageService &&
    'readUploadMeta' in storageService &&
    'touchUploadMeta' in storageService
  );
}

function isMissingUploadMeta(error: unknown): boolean {
  return error instanceof AppError && error.code === 'UPLOAD_NOT_FOUND';
}

export function createUploadStorageAdapter(storageService: UploadStorageService | FilesystemStorageService): UploadStorageService {
  if (hasExpectedStorageContract(storageService)) {
    return storageService;
  }

  return {
    async findMergedFile(fileHash) {
      if (!(await storageService.mergedFileExists(fileHash))) {
        return null;
      }

      return storageService.readMergedFileMeta(fileHash);
    },
    listUploadedChunks(fileHash) {
      return storageService.scanUploadedChunks(fileHash);
    },
    async readUploadMeta(fileHash) {
      try {
        return await storageService.readUploadMeta(fileHash);
      } catch (error) {
        if (isMissingUploadMeta(error)) {
          return null;
        }

        throw error;
      }
    },
    async touchUploadMeta(fileHash, accessedAt) {
      await storageService.updateUploadMeta(fileHash, (current) => ({
        ...current,
        updatedAt: accessedAt,
        lastAccessedAt: accessedAt
      }));
    },
    writeUploadMeta(meta) {
      if (!storageService.writeUploadMeta) {
        throw new AppError(500, 'STORAGE_ERROR', 'storage service does not support upload meta writes');
      }

      return storageService.writeUploadMeta(meta);
    },
    writeChunk(params) {
      if (!storageService.writeChunk) {
        throw new AppError(500, 'STORAGE_ERROR', 'storage service does not support chunk writes');
      }

      return storageService.writeChunk(params);
    },
    async deleteChunkDir(fileHash) {
      const fs = storageService as FilesystemStorageService;

      if (fs.getChunkDir) {
        await rm(fs.getChunkDir(fileHash), { recursive: true, force: true });
        return;
      }
    }
  };
}

async function loadDefaultStorage(): Promise<UploadStorageService> {
  const storageModule = await import(storageModulePath);
  const storage = storageModule.storageService ?? storageModule.default;

  if (!storage) {
    throw new AppError(500, 'STORAGE_ERROR', 'storageService export is missing');
  }

  return createUploadStorageAdapter(storage);
}

function createLazyStorageService(): UploadStorageService {
  return {
    async findMergedFile(fileHash) {
      return (await loadDefaultStorage()).findMergedFile(fileHash);
    },
    async listUploadedChunks(fileHash) {
      return (await loadDefaultStorage()).listUploadedChunks(fileHash);
    },
    async readUploadMeta(fileHash) {
      return (await loadDefaultStorage()).readUploadMeta(fileHash);
    },
    async touchUploadMeta(fileHash, accessedAt) {
      return (await loadDefaultStorage()).touchUploadMeta(fileHash, accessedAt);
    },
    async writeUploadMeta(meta) {
      const storage = await loadDefaultStorage();
      assertUploadStorage(storage);
      return storage.writeUploadMeta(meta);
    },
    async writeChunk(params) {
      const storage = await loadDefaultStorage();
      assertUploadStorage(storage);
      return storage.writeChunk(params);
    },
    async deleteChunkDir(fileHash) {
      const storage = await loadDefaultStorage();

      if (storage.deleteChunkDir) {
        return storage.deleteChunkDir(fileHash);
      }
    }
  };
}

export function createUploadService(storageService: UploadStorageService = createLazyStorageService()): UploadService {
  return {
    async checkUpload(input) {
      const { fileHash } = validateCheckInput(input);
      const mergedFile = await storageService.findMergedFile(fileHash);

      // 秒传优先：正式合并文件存在时，不再关心临时分片目录。
      if (mergedFile) {
        return {
          exists: true,
          uploadedChunks: [],
          fileUrl: mergedFile.fileUrl
        };
      }

      return {
        exists: false,
        uploadedChunks: sortChunkIndexes(await storageService.listUploadedChunks(fileHash)),
        fileUrl: null
      };
    },

    async uploadChunk(input) {
      assertUploadStorage(storageService);

      const validatedInput = validateChunkInput(input);
      const now = new Date().toISOString();
      const incomingMeta = createUploadMeta(validatedInput, now);
      const existingMeta = await storageService.readUploadMeta(validatedInput.fileHash);

      // 首片负责创建 meta；后续分片只刷新活跃时间，并校验 meta 一致性。
      if (existingMeta) {
        if (hasMetaConflict(existingMeta, incomingMeta)) {
          throw new AppError(400, 'META_CONFLICT', 'upload metadata conflicts with existing metadata', {
            fileHash: validatedInput.fileHash
          });
        }

        await storageService.touchUploadMeta(validatedInput.fileHash, now);
      } else {
        await storageService.writeUploadMeta(incomingMeta);
      }

      // 适配 diskStorage：buffer 不存在时从磁盘读取分片内容。
      let chunkData: Buffer;
      if (validatedInput.chunk.buffer) {
        chunkData = Buffer.isBuffer(validatedInput.chunk.buffer)
          ? validatedInput.chunk.buffer
          : Buffer.from(validatedInput.chunk.buffer);
      } else if (validatedInput.chunk.path) {
        chunkData = await readFile(validatedInput.chunk.path);
        await unlink(validatedInput.chunk.path).catch(() => undefined);
      } else {
        throw new AppError(400, 'INVALID_ARGUMENT', 'chunk data is missing');
      }

      await storageService.writeChunk({
        fileHash: validatedInput.fileHash,
        chunkIndex: validatedInput.chunkIndex,
        data: chunkData
      });

      return {
        chunkIndex: validatedInput.chunkIndex,
        uploaded: true
      };
    },

    async getUploadStatus(rawFileHash) {
      const fileHash = validateFileHash(rawFileHash);
      const mergedFile = await storageService.findMergedFile(fileHash);

      // 状态查询同样优先返回 MERGED，使前端恢复时能直接进入成功/下载路径。
      if (mergedFile) {
        return {
          fileHash,
          status: 'MERGED',
          uploadedChunks: [],
          fileUrl: mergedFile.fileUrl
        };
      }

      const [uploadedChunks, uploadMeta] = await Promise.all([
        storageService.listUploadedChunks(fileHash),
        storageService.readUploadMeta(fileHash)
      ]);
      const sortedUploadedChunks = sortChunkIndexes(uploadedChunks);

      if (!uploadMeta && sortedUploadedChunks.length === 0) {
        return {
          fileHash,
          status: 'NOT_FOUND',
          uploadedChunks: [],
          fileUrl: null
        };
      }

      const status: UploadStatus = uploadMeta?.status === 'MERGING' ? 'MERGING' : 'UPLOADING';
      // 用户查询状态通常意味着正在恢复上传，刷新 lastAccessedAt 防止清理任务误删。
      await storageService.touchUploadMeta(fileHash, new Date().toISOString());

      return {
        fileHash,
        status,
        uploadedChunks: sortedUploadedChunks,
        fileUrl: null
      };
    },

    async cancelUpload(rawFileHash) {
      const fileHash = validateFileHash(rawFileHash);
      // 只删除临时分片目录，不删除已合并的正式文件。
      await storageService.deleteChunkDir?.(fileHash);
      return { fileHash, canceled: true };
    }
  };
}

export const uploadService = createUploadService();
