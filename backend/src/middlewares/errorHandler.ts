import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../types/errorTypes.js';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', '接口不存在', { path: req.path }));
};

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      code: error.code,
      message: error.message,
      details: error.details
    });
    return;
  }

  res.status(500).json({
    code: 'STORAGE_ERROR',
    message: '服务器内部错误'
  });
};

