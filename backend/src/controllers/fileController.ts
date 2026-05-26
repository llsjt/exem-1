import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '../types/errorTypes.js';
import { storageService, type StorageService } from '../storage/storageService.js';

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

function asyncHandler(handler: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

function sanitizeDownloadFileName(fileName: string): string {
  return fileName.replace(/[\r\n"]/g, '_');
}

function assertValidFileHash(fileHash: unknown, storage: StorageService): string {
  if (typeof fileHash !== 'string' || !storage.isValidFileHash(fileHash)) {
    throw new AppError(400, 'INVALID_FILE_HASH', 'Invalid fileHash', { fileHash });
  }

  return fileHash;
}

function isMissingFileError(error: unknown): boolean {
  return (
    (error instanceof AppError && error.code === 'FILE_NOT_FOUND') ||
    (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
  );
}

export function createFileController(storage: StorageService = storageService) {
  return {
    getFile: asyncHandler(async (req, res, next) => {
      const fileHash = assertValidFileHash(req.params.fileHash, storage);
      const filePath = storage.getMergedFilePath(fileHash);

      try {
        const [meta, fileStat] = await Promise.all([storage.readMergedFileMeta(fileHash), stat(filePath)]);

        if (!fileStat.isFile()) {
          throw new AppError(404, 'FILE_NOT_FOUND', 'merged file not found', { fileHash });
        }

        res.setHeader('Content-Type', meta.mimeType || 'application/octet-stream');
        res.setHeader('Content-Length', String(fileStat.size));
        res.setHeader('Content-Disposition', `attachment; filename="${sanitizeDownloadFileName(meta.fileName)}"`);

        const stream = createReadStream(filePath);
        stream.on('error', next);
        stream.pipe(res);
      } catch (error) {
        if (isMissingFileError(error)) {
          throw new AppError(404, 'FILE_NOT_FOUND', 'merged file not found', { fileHash });
        }

        throw error;
      }
    })
  };
}
