import multer from 'multer';

export const uploadChunkMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1
  }
}).single('chunk');
