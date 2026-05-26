import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createUploadService, createUploadStorageAdapter, type UploadStorageService } from '../src/services/uploadService.js';

const fileHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function createStorage(overrides: Partial<UploadStorageService> = {}): UploadStorageService {
  return {
    findMergedFile: vi.fn().mockResolvedValue(null),
    listUploadedChunks: vi.fn().mockResolvedValue([]),
    readUploadMeta: vi.fn().mockResolvedValue(null),
    touchUploadMeta: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

function createTestApp(storage: UploadStorageService) {
  return createApp({ uploadService: createUploadService(storage) });
}

function validCheckBody(overrides: Record<string, unknown> = {}) {
  return {
    fileHash,
    fileName: 'video.mp4',
    fileSize: 11,
    chunkSize: 5,
    totalChunks: 3,
    mimeType: 'video/mp4',
    ...overrides
  };
}

describe('upload check/status endpoints', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('returns exists=false and an empty uploadedChunks list when no upload data exists', async () => {
    const app = createTestApp(createStorage());

    const response = await request(app).post('/api/uploads/check').send(validCheckBody());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      exists: false,
      uploadedChunks: [],
      fileUrl: null
    });
  });

  it('returns uploaded chunk indexes when temporary chunks exist', async () => {
    const storage = createStorage({
      listUploadedChunks: vi.fn().mockResolvedValue([2, 0])
    });
    const app = createTestApp(storage);

    const response = await request(app).post('/api/uploads/check').send(validCheckBody());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      exists: false,
      uploadedChunks: [0, 2],
      fileUrl: null
    });
  });

  it('returns exists=true and fileUrl when merged file already exists', async () => {
    const storage = createStorage({
      findMergedFile: vi.fn().mockResolvedValue({ fileUrl: `/api/files/${fileHash}` }),
      listUploadedChunks: vi.fn().mockResolvedValue([0, 1])
    });
    const app = createTestApp(storage);

    const response = await request(app).post('/api/uploads/check').send(validCheckBody());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      exists: true,
      uploadedChunks: [],
      fileUrl: `/api/files/${fileHash}`
    });
  });

  it('rejects missing or invalid fileHash with INVALID_FILE_HASH', async () => {
    const app = createTestApp(createStorage());

    const missingResponse = await request(app).post('/api/uploads/check').send(validCheckBody({ fileHash: undefined }));
    const invalidResponse = await request(app).get('/api/uploads/not-a-hash/status');

    expect(missingResponse.status).toBe(400);
    expect(missingResponse.body.code).toBe('INVALID_FILE_HASH');
    expect(invalidResponse.status).toBe(400);
    expect(invalidResponse.body.code).toBe('INVALID_FILE_HASH');
  });

  it('rejects non-positive size arguments with INVALID_ARGUMENT', async () => {
    const app = createTestApp(createStorage());

    const response = await request(app).post('/api/uploads/check').send(validCheckBody({ chunkSize: 0 }));

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_ARGUMENT');
  });

  it('rejects inconsistent totalChunks with INVALID_ARGUMENT', async () => {
    const app = createTestApp(createStorage());

    const response = await request(app).post('/api/uploads/check').send(validCheckBody({ totalChunks: 2 }));

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_ARGUMENT');
  });

  it('returns NOT_FOUND status when neither merged file nor temporary upload exists', async () => {
    const app = createTestApp(createStorage());

    const response = await request(app).get(`/api/uploads/${fileHash}/status`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      fileHash,
      status: 'NOT_FOUND',
      uploadedChunks: [],
      fileUrl: null
    });
  });

  it('returns UPLOADING status and touches metadata for unmerged uploads', async () => {
    const touchUploadMeta = vi.fn().mockResolvedValue(undefined);
    const storage = createStorage({
      listUploadedChunks: vi.fn().mockResolvedValue([1, 0]),
      readUploadMeta: vi.fn().mockResolvedValue({ status: 'UPLOADING' }),
      touchUploadMeta
    });
    const app = createTestApp(storage);

    const response = await request(app).get(`/api/uploads/${fileHash}/status`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      fileHash,
      status: 'UPLOADING',
      uploadedChunks: [0, 1],
      fileUrl: null
    });
    expect(touchUploadMeta).toHaveBeenCalledWith(fileHash, expect.any(String));
  });

  it('returns MERGING status from upload metadata', async () => {
    const storage = createStorage({
      listUploadedChunks: vi.fn().mockResolvedValue([0, 1]),
      readUploadMeta: vi.fn().mockResolvedValue({ status: 'MERGING' })
    });
    const app = createTestApp(storage);

    const response = await request(app).get(`/api/uploads/${fileHash}/status`);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('MERGING');
    expect(response.body.uploadedChunks).toEqual([0, 1]);
  });

  it('returns MERGED status before checking temporary upload data', async () => {
    const listUploadedChunks = vi.fn().mockResolvedValue([0, 1]);
    const storage = createStorage({
      findMergedFile: vi.fn().mockResolvedValue({ fileUrl: `/api/files/${fileHash}` }),
      listUploadedChunks
    });
    const app = createTestApp(storage);

    const response = await request(app).get(`/api/uploads/${fileHash}/status`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      fileHash,
      status: 'MERGED',
      uploadedChunks: [],
      fileUrl: `/api/files/${fileHash}`
    });
    expect(listUploadedChunks).not.toHaveBeenCalled();
  });

  it('adapts the filesystem storage service contract used by the storage agent', async () => {
    const updateUploadMeta = vi.fn(async (_hash, updater) =>
      updater({
        fileHash,
        fileName: 'video.mp4',
        fileSize: 11,
        chunkSize: 5,
        totalChunks: 3,
        schemaVersion: 1,
        status: 'UPLOADING',
        createdAt: '2026-05-26T00:00:00.000Z',
        updatedAt: '2026-05-26T00:00:00.000Z'
      })
    );
    const storage = createUploadStorageAdapter({
      mergedFileExists: vi.fn().mockResolvedValue(false),
      readMergedFileMeta: vi.fn(),
      scanUploadedChunks: vi.fn().mockResolvedValue([2, 0]),
      readUploadMeta: vi.fn().mockResolvedValue({ status: 'UPLOADING' }),
      updateUploadMeta
    });
    const app = createTestApp(storage);

    const response = await request(app).get(`/api/uploads/${fileHash}/status`);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('UPLOADING');
    expect(response.body.uploadedChunks).toEqual([0, 2]);
    expect(updateUploadMeta).toHaveBeenCalledWith(fileHash, expect.any(Function));
  });
});
