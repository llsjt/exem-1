export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_FILE_HASH'
  | 'UPLOAD_NOT_FOUND'
  | 'MISSING_CHUNK'
  | 'META_CONFLICT'
  | 'MERGE_IN_PROGRESS'
  | 'FILE_NOT_FOUND'
  | 'STORAGE_ERROR'
  | 'NOT_FOUND';

export interface ErrorResponse {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(statusCode: number, code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

