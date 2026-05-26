import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createMergeService } from '../src/services/mergeService.js';
import { createUploadService, createUploadStorageAdapter } from '../src/services/uploadService.js';
import { createStorageService, type StorageService } from '../src/storage/storageService.js';

const fileHash = 'cccccccccccccccccccccccccccccccc';

function mergeBody(overrides: Record<string, unknown> = {}) {
  return {
    fileHash,
    fileName: 'notes.txt',
    fileSize: 11,
    totalChunks: 3,
    mimeType: 'text/plain',
    ...overrides
  };
}

describe('merge and file access endpoints', () => {
  let storageRoot: string;
  let storage: StorageService;

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), 'exam-merge-files-'));
    storage = createStorageService({ storageRoot });
    await storage.initStorage();
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  function createTestApp() {
    return createApp({
      uploadService: createUploadService(createUploadStorageAdapter(storage)),
      mergeService: createMergeService(storage),
      fileStorageService: storage
    });
  }

  async function seedUpload(chunks: Array<{ index: number; data: Buffer }>) {
    const now = new Date().toISOString();
    await storage.writeUploadMeta({
      fileHash,
      fileName: 'notes.txt',
      fileSize: 11,
      chunkSize: 5,
      totalChunks: 3,
      mimeType: 'text/plain',
      schemaVersion: 1,
      status: 'UPLOADING',
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now
    });

    await Promise.all(
      chunks.map((chunk) =>
        storage.writeChunk({
          fileHash,
          chunkIndex: chunk.index,
          data: chunk.data
        })
      )
    );
  }

  it('merges uploaded chunks in chunkIndex order, writes merged metadata, and removes temporary chunks', async () => {
    await seedUpload([
      { index: 2, data: Buffer.from('!') },
      { index: 0, data: Buffer.from('hello') },
      { index: 1, data: Buffer.from('world') }
    ]);

    const response = await request(createTestApp()).post('/api/uploads/merge').send(mergeBody());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      fileHash,
      fileName: 'notes.txt',
      fileSize: 11,
      status: 'MERGED',
      fileUrl: `/api/files/${fileHash}`
    });
    await expect(readFile(storage.getMergedFilePath(fileHash), 'utf8')).resolves.toBe('helloworld!');
    await expect(storage.readMergedFileMeta(fileHash)).resolves.toMatchObject({
      fileHash,
      fileName: 'notes.txt',
      fileSize: 11,
      mimeType: 'text/plain',
      schemaVersion: 1,
      status: 'MERGED',
      fileUrl: `/api/files/${fileHash}`
    });
    await expect(stat(storage.getChunkDir(fileHash))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns MISSING_CHUNK when any required chunk file is absent', async () => {
    await seedUpload([
      { index: 0, data: Buffer.from('hello') },
      { index: 2, data: Buffer.from('!') }
    ]);

    const response = await request(createTestApp()).post('/api/uploads/merge').send(mergeBody());

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'MISSING_CHUNK',
      details: {
        fileHash,
        chunkIndex: 1
      }
    });
  });

  it('returns META_CONFLICT when merge request metadata differs from upload metadata', async () => {
    await seedUpload([
      { index: 0, data: Buffer.from('hello') },
      { index: 1, data: Buffer.from('world') },
      { index: 2, data: Buffer.from('!') }
    ]);

    const response = await request(createTestApp()).post('/api/uploads/merge').send(mergeBody({ fileName: 'other.txt' }));

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('META_CONFLICT');
  });

  it('returns MERGE_IN_PROGRESS for concurrent duplicate merge requests while the first merge holds the lock', async () => {
    await seedUpload([
      { index: 0, data: Buffer.from('hello') },
      { index: 1, data: Buffer.from('world') },
      { index: 2, data: Buffer.from('!') }
    ]);
    const app = createTestApp();

    const [firstResponse, secondResponse] = await Promise.all([
      request(app).post('/api/uploads/merge').send(mergeBody()),
      request(app).post('/api/uploads/merge').send(mergeBody())
    ]);
    const statuses = [firstResponse.status, secondResponse.status].sort();
    const codes = [firstResponse.body.code, secondResponse.body.code].filter(Boolean);

    expect(statuses).toEqual([200, 409]);
    expect(codes).toEqual(['MERGE_IN_PROGRESS']);
    await expect(readFile(storage.getMergedFilePath(fileHash), 'utf8')).resolves.toBe('helloworld!');
  });

  it('returns the already merged file result idempotently', async () => {
    await seedUpload([
      { index: 0, data: Buffer.from('hello') },
      { index: 1, data: Buffer.from('world') },
      { index: 2, data: Buffer.from('!') }
    ]);
    const app = createTestApp();
    await request(app).post('/api/uploads/merge').send(mergeBody());

    const response = await request(app).post('/api/uploads/merge').send(mergeBody());

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      fileHash,
      status: 'MERGED',
      fileUrl: `/api/files/${fileHash}`
    });
  });

  it('streams a merged file with metadata content type and sanitized download filename', async () => {
    await storage.ensureFileDir(fileHash);
    await writeFile(storage.getMergedFilePath(fileHash), Buffer.from('download-body'));
    await storage.writeMergedFileMeta({
      fileHash,
      fileName: 'bad\r\nname.txt',
      fileSize: 13,
      mimeType: 'text/plain',
      schemaVersion: 1,
      status: 'MERGED',
      fileUrl: `/api/files/${fileHash}`,
      completedAt: new Date().toISOString()
    });

    const response = await request(createTestApp()).get(`/api/files/${fileHash}`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.headers['content-disposition']).toBe('attachment; filename="bad__name.txt"');
    expect(response.text).toBe('download-body');
  });

  it('returns FILE_NOT_FOUND when the merged file is missing', async () => {
    const response = await request(createTestApp()).get(`/api/files/${fileHash}`);

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('FILE_NOT_FOUND');
  });
});
