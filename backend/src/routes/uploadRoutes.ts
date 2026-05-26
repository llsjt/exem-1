import { Router } from 'express';
import { createUploadController } from '../controllers/uploadController.js';
import { uploadChunkMiddleware } from '../middlewares/uploadMiddleware.js';
import { mergeService, type MergeService } from '../services/mergeService.js';
import { uploadService, type UploadService } from '../services/uploadService.js';

export function createUploadRoutes(service: UploadService = uploadService, merger: MergeService = mergeService) {
  const router = Router();
  const controller = createUploadController(service, merger);

  router.post('/check', controller.checkUpload);
  router.post('/chunks', uploadChunkMiddleware, controller.uploadChunk);
  router.post('/merge', controller.mergeUpload);
  router.get('/:fileHash/status', controller.getUploadStatus);

  return router;
}
