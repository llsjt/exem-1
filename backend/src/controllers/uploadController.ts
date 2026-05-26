import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { mergeService, type MergeService } from '../services/mergeService.js';
import { uploadService, type UploadService } from '../services/uploadService.js';

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

function asyncHandler(handler: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

export function createUploadController(service: UploadService = uploadService, merger: MergeService = mergeService) {
  return {
    checkUpload: asyncHandler(async (req, res) => {
      const result = await service.checkUpload(req.body);
      res.json(result);
    }),

    uploadChunk: asyncHandler(async (req, res) => {
      const result = await service.uploadChunk({
        ...req.body,
        chunk: req.file
      });
      res.json(result);
    }),

    getUploadStatus: asyncHandler(async (req, res) => {
      const result = await service.getUploadStatus(req.params.fileHash);
      res.json(result);
    }),

    mergeUpload: asyncHandler(async (req, res) => {
      const result = await merger.mergeUpload(req.body);
      res.json(result);
    })
  };
}
