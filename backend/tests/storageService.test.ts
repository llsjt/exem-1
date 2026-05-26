import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorageService, isValidFileHash } from '../src/storage/storageService.js';
import type { UploadMeta } from '../src/types/uploadTypes.js';

describe('storageService', () => {
  let storageRoot: string;

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), 'exam-upload-storage-'));
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  function createService() {
    return createStorageService({ storageRoot });
  }

  function createMeta(fileHash = '0123456789abcdef0123456789abcdef'): UploadMeta {
    return {
      fileHash,
      fileName: 'video.mp4',
      fileSize: 11,
      chunkSize: 5,
      totalChunks: 3,
      mimeType: 'video/mp4',
      schemaVersion: 1,
      status: 'UPLOADING',
      createdAt: '2026-05-26T00:00:00.000Z',
      updatedAt: '2026-05-26T00:00:00.000Z',
      lastAccessedAt: '2026-05-26T00:00:00.000Z'
    };
  }

  it('initializes storage/chunks and storage/files under the configured root', async () => {
    const service = createService();

    await service.initStorage();

    await expect(stat(path.join(storageRoot, 'chunks'))).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(stat(path.join(storageRoot, 'files'))).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it('accepts only 32 character MD5 hex hashes and rejects path traversal input', () => {
    expect(isValidFileHash('0123456789abcdefABCDEF0123456789')).toBe(true);
    expect(isValidFileHash('../0123456789abcdef0123456789abc')).toBe(false);
    expect(isValidFileHash('0123456789abcdef0123456789abcdeg')).toBe(false);
    expect(isValidFileHash('0123456789abcdef0123456789abcde')).toBe(false);

    const service = createService();
    expect(() => service.getChunkDir('../0123456789abcdef0123456789abc')).toThrow(/fileHash/);
  });

  it('writes, reads, and updates meta.json through the storage service', async () => {
    const service = createService();
    const meta = createMeta();

    await service.writeUploadMeta(meta);
    await expect(service.readUploadMeta(meta.fileHash)).resolves.toEqual(meta);

    const updated = await service.updateUploadMeta(meta.fileHash, (current) => ({
      ...current,
      status: 'MERGING',
      updatedAt: '2026-05-26T00:01:00.000Z'
    }));

    expect(updated.status).toBe('MERGING');
    await expect(service.readUploadMeta(meta.fileHash)).resolves.toMatchObject({
      status: 'MERGING',
      updatedAt: '2026-05-26T00:01:00.000Z'
    });
  });

  it('scans only finalized .part chunks and ignores .part.tmp leftovers', async () => {
    const service = createService();
    const fileHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const chunkDir = await service.ensureChunkDir(fileHash);

    await writeFile(path.join(chunkDir, '2.part'), 'chunk-2');
    await writeFile(path.join(chunkDir, '0.part'), 'chunk-0');
    await writeFile(path.join(chunkDir, '1.part.tmp'), 'incomplete');
    await writeFile(path.join(chunkDir, 'note.txt'), 'ignore');

    await expect(service.scanUploadedChunks(fileHash)).resolves.toEqual([0, 2]);
  });

  it('writes chunks through .part.tmp then finalizes to .part and keeps duplicate uploads idempotent', async () => {
    const service = createService();
    const fileHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    const first = await service.writeChunk({ fileHash, chunkIndex: 0, data: Buffer.from('first') });
    const second = await service.writeChunk({ fileHash, chunkIndex: 0, data: Buffer.from('second') });

    expect(first).toEqual({ chunkIndex: 0, uploaded: true, skipped: false });
    expect(second).toEqual({ chunkIndex: 0, uploaded: true, skipped: true });

    const chunkDir = service.getChunkDir(fileHash);
    await expect(readFile(path.join(chunkDir, '0.part'), 'utf8')).resolves.toBe('first');
    await expect(stat(path.join(chunkDir, '0.part.tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(service.scanUploadedChunks(fileHash)).resolves.toEqual([0]);
  });
});
