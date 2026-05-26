import cors from 'cors';
import express from 'express';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';
import { createFileRoutes } from './routes/fileRoutes.js';
import { createUploadRoutes } from './routes/uploadRoutes.js';
import type { MergeService } from './services/mergeService.js';
import type { UploadService } from './services/uploadService.js';
import type { StorageService } from './storage/storageService.js';

interface CreateAppOptions {
  uploadService?: UploadService;
  mergeService?: MergeService;
  fileStorageService?: StorageService;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/uploads', createUploadRoutes(options.uploadService, options.mergeService));
  app.use('/api/files', createFileRoutes(options.fileStorageService));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
