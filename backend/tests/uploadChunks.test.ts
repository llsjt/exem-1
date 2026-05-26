import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createUploadService, createUploadStorageAdapter } from '../src/services/uploadService.js';
import { createStorageService, type StorageService } from '../src/storage/storageService.js';

const fileHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function chunkFields(overrides: Record<string, string | number | undefined> = {}) {
  return {
    fileHash,
    fileName: 'video.mp4',
    fileSize: 11,
    chunkSize: 5,
    totalChunks: 3,
    chunkIndex: 0,
    mimeType: 'video/mp4',
    ...overrides
  };
}

function attachFields(requestBuilder: request.Test, fields: Record<string, string | number | undefined>) {
  return Object.entries(fields).reduce((builder, [key, value]) => {
    if (value === undefined) {
      return builder;
    }

    return builder.field(key, String(value));
  }, requestBuilder);
}

describe('upload chunk endpoint', () => {
  let storageRoot: string;
  let storage: StorageService;

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), 'exam-upload-chunks-'));
    storage = createStorageService({ storageRoot });
    await storage.initStorage();
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  function createTestApp() {
    return createApp({ uploadService: createUploadService(createUploadStorageAdapter(storage)) });
  }

  async function uploadChunk(overrides: Record<string, string | number | undefined> = {}, chunk = Buffer.alloc(5, 'a')) {
    const builder = request(createTestApp()).post('/api/uploads/chunks');
    return attachFields(builder, chunkFields(overrides)).attach('chunk', chunk, '0.part');
  }

  it('stores a chunk as a finalized .part file and writes upload metadata on first upload', async () => {
    const response = await uploadChunk();

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ chunkIndex: 0, uploaded: true });
    await expect(readFile(storage.getChunkPath(fileHash, 0))).resolves.toEqual(Buffer.alloc(5, 'a'));
    await expect(stat(storage.getTempChunkPath(fileHash, 0))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(storage.readUploadMeta(fileHash)).resolves.toMatchObject({
      fileHash,
      fileName: 'video.mp4',
      fileSize: 11,
      chunkSize: 5,
      totalChunks: 3,
      mimeType: 'video/mp4',
      schemaVersion: 1,
      status: 'UPLOADING'
    });
  });

  it('keeps duplicate uploads of the same chunk idempotent', async () => {
    await uploadChunk();

    const response = await uploadChunk({}, Buffer.alloc(5, 'z'));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ chunkIndex: 0, uploaded: true });
    await expect(readFile(storage.getChunkPath(fileHash, 0))).resolves.toEqual(Buffer.alloc(5, 'a'));
  });

  it('rejects a missing chunk file with INVALID_ARGUMENT', async () => {
    const builder = request(createTestApp()).post('/api/uploads/chunks');

    const response = await attachFields(builder, chunkFields());

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_ARGUMENT');
  });

  it('rejects an out-of-range chunkIndex with INVALID_ARGUMENT', async () => {
    const response = await uploadChunk({ chunkIndex: 3 });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_ARGUMENT');
  });

  it('rejects non-final chunks whose uploaded size does not equal chunkSize', async () => {
    const response = await uploadChunk({}, Buffer.alloc(4, 'a'));

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_ARGUMENT');
  });

  it('allows the final chunk to be smaller than chunkSize', async () => {
    const response = await uploadChunk({ chunkIndex: 2 }, Buffer.alloc(1, 'c'));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ chunkIndex: 2, uploaded: true });
    await expect(readFile(storage.getChunkPath(fileHash, 2))).resolves.toEqual(Buffer.alloc(1, 'c'));
  });

  it('rejects metadata that conflicts with an existing upload', async () => {
    await uploadChunk();

    const response = await uploadChunk({ fileSize: 12, totalChunks: 3 });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('META_CONFLICT');
  });

  it('does not expose interrupted temporary chunk files through status', async () => {
    await storage.ensureChunkDir(fileHash);
    await writeFile(storage.getTempChunkPath(fileHash, 1), Buffer.alloc(5, 'x'));

    const response = await request(createTestApp()).get(`/api/uploads/${fileHash}/status`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'NOT_FOUND',
      uploadedChunks: []
    });
  });
});
