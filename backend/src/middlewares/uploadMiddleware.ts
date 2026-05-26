import { mkdirSync } from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { createUploadConfig } from '../config/uploadConfig.js';

const config = createUploadConfig();
const tmpDir = path.join(config.storageRoot, 'tmp');
mkdirSync(tmpDir, { recursive: true });

// 使用 diskStorage，分片先落到 storage/ 所在磁盘，避免从系统临时目录跨分区移动。
export const uploadChunkMiddleware = multer({
  storage: multer.diskStorage({
    destination: tmpDir,
    filename: (_req, file, cb) => {
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${uniqueSuffix}-${file.originalname}`);
    }
  }),
  limits: {
    files: 1
  }
}).single('chunk');
