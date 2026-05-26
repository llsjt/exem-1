import { Router } from 'express';
import { createFileController } from '../controllers/fileController.js';
import { storageService, type StorageService } from '../storage/storageService.js';

export function createFileRoutes(storage: StorageService = storageService) {
  const router = Router();
  const controller = createFileController(storage);

  router.get('/:fileHash', controller.getFile);

  return router;
}
