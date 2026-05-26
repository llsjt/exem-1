import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createMergeService } from '../src/services/mergeService.js';
import { createUploadService, createUploadStorageAdapter } from '../src/services/uploadService.js';
import { createStorageService, type StorageService } from '../src/storage/storageService.js';

const fileHash = 'cccccccccccccccccccccccccccccccc';

function fields(overrides: Record<string, string | number> = {}) {
  return {
    fileHash,
    fileName: 'sample.bin',
    fileSize: 12,
    chunkSize: 4,
    totalChunks: 3,
    mimeType: 'application/octet-stream',
    ...overrides
  };
}

function attachFields(builder: request.Test, payload: Record<string, string | number>) {
  return Object.entries(payload).reduce((next, [key, value]) => next.field(key, String(value)), builder);
}

describe('upload flow integration', () => {
  let storageRoot: string;
  let storage: StorageService;

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), 'exam-upload-flow-'));
    storage = createStorageService({ storageRoot });
    await storage.initStorage();
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  function app() {
    return createApp({
      uploadService: createUploadService(createUploadStorageAdapter(storage)),
      mergeService: createMergeService(storage),
      fileStorageService: storage
    });
  }

  async function uploadChunk(chunkIndex: number, content: string) {
    const builder = request(app()).post('/api/uploads/chunks');
    return attachFields(builder, fields({ chunkIndex })).attach('chunk', Buffer.from(content), `${chunkIndex}.part`);
  }

  it('runs check -> chunks -> status with fileHash across the backend flow', async () => {
    const checkBefore = await request(app()).post('/api/uploads/check').send(fields());
    expect(checkBefore.status).toBe(200);
    expect(checkBefore.body).toEqual({ exists: false, uploadedChunks: [], fileUrl: null });

    await expect(uploadChunk(0, 'aaaa')).resolves.toMatchObject({ status: 200, body: { chunkIndex: 0, uploaded: true } });
    await expect(uploadChunk(1, 'bbbb')).resolves.toMatchObject({ status: 200, body: { chunkIndex: 1, uploaded: true } });
    await expect(uploadChunk(2, 'cccc')).resolves.toMatchObject({ status: 200, body: { chunkIndex: 2, uploaded: true } });

    const status = await request(app()).get(`/api/uploads/${fileHash}/status`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      fileHash,
      status: 'UPLOADING',
      uploadedChunks: [0, 1, 2],
      fileUrl: null
    });

    const checkAfter = await request(app()).post('/api/uploads/check').send(fields());
    expect(checkAfter.body).toEqual({ exists: false, uploadedChunks: [0, 1, 2], fileUrl: null });
  });

  it('keeps metadata stable when the same chunk is uploaded again', async () => {
    await uploadChunk(0, 'aaaa');
    const before = await storage.readUploadMeta(fileHash);

    const duplicate = await uploadChunk(0, 'zzzz');
    const after = await storage.readUploadMeta(fileHash);

    expect(duplicate.status).toBe(200);
    expect(after).toMatchObject({
      fileHash: before.fileHash,
      fileName: before.fileName,
      fileSize: before.fileSize,
      chunkSize: before.chunkSize,
      totalChunks: before.totalChunks,
      mimeType: before.mimeType,
      status: 'UPLOADING'
    });
  });

  it('runs chunks -> merge -> file access -> instant check for the full MVP backend path', async () => {
    await uploadChunk(0, 'aaaa');
    await uploadChunk(1, 'bbbb');
    await uploadChunk(2, 'cccc');

    const merge = await request(app()).post('/api/uploads/merge').send({
      fileHash,
      fileName: 'sample.bin',
      fileSize: 12,
      totalChunks: 3,
      mimeType: 'application/octet-stream'
    });
    expect(merge.status).toBe(200);
    expect(merge.body).toEqual({
      fileHash,
      fileName: 'sample.bin',
      fileSize: 12,
      status: 'MERGED',
      fileUrl: `/api/files/${fileHash}`
    });

    const file = await request(app()).get(`/api/files/${fileHash}`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('application/octet-stream');
    expect(Buffer.from(file.body).toString('utf8')).toBe('aaaabbbbcccc');

    const instantCheck = await request(app()).post('/api/uploads/check').send(fields());
    expect(instantCheck.body).toEqual({
      exists: true,
      uploadedChunks: [],
      fileUrl: `/api/files/${fileHash}`
    });
  });
});
