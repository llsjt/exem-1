import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCleanupService } from '../src/services/cleanupService.js';
import type { UploadMeta } from '../src/types/uploadTypes.js';

const oldTime = '2026-05-24T00:00:00.000Z';
const recentTime = '2026-05-26T00:00:00.000Z';
const now = new Date('2026-05-26T12:00:00.000Z');
const expireMs = 24 * 60 * 60 * 1000;

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function meta(fileHash: string, overrides: Partial<UploadMeta> = {}): UploadMeta {
  return {
    fileHash,
    fileName: 'video.mp4',
    fileSize: 11,
    chunkSize: 5,
    totalChunks: 3,
    schemaVersion: 1,
    status: 'UPLOADING',
    createdAt: oldTime,
    updatedAt: oldTime,
    ...overrides
  };
}

describe('cleanupService', () => {
  let storageRoot: string;
  let chunksRoot: string;
  let filesRoot: string;

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), 'exam-upload-cleanup-'));
    chunksRoot = path.join(storageRoot, 'chunks');
    filesRoot = path.join(storageRoot, 'files');
    await mkdir(chunksRoot, { recursive: true });
    await mkdir(filesRoot, { recursive: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(storageRoot, { recursive: true, force: true });
  });

  async function writeChunkDir(fileHash: string, uploadMeta?: UploadMeta) {
    const chunkDir = path.join(chunksRoot, fileHash);
    await mkdir(chunkDir, { recursive: true });
    await writeFile(path.join(chunkDir, '0.part'), 'chunk-0');

    if (uploadMeta) {
      await writeFile(path.join(chunkDir, 'meta.json'), `${JSON.stringify(uploadMeta, null, 2)}\n`, 'utf8');
    }

    return chunkDir;
  }

  function createService(overrides: Parameters<typeof createCleanupService>[0] = {}) {
    return createCleanupService({
      config: {
        chunksRoot,
        filesRoot,
        chunkExpireHours: 24,
        cleanupCron: '*/30 * * * *'
      },
      now: () => now,
      lockManager: { isLocked: vi.fn().mockReturnValue(false) },
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
      ...overrides
    });
  }

  it('deletes expired unmerged chunk directories', async () => {
    const fileHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const chunkDir = await writeChunkDir(fileHash, meta(fileHash));

    const result = await createService().runCleanup();

    expect(await exists(chunkDir)).toBe(false);
    expect(result.deleted).toEqual([fileHash]);
  });

  it('does not delete merged files under storage/files', async () => {
    const fileHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const fileDir = path.join(filesRoot, fileHash);
    await mkdir(fileDir, { recursive: true });
    await writeFile(path.join(fileDir, 'file'), 'merged');

    await createService().runCleanup();

    await expect(stat(path.join(fileDir, 'file'))).resolves.toMatchObject({ isFile: expect.any(Function) });
  });

  it('keeps chunk directories whose updatedAt has not expired', async () => {
    const fileHash = 'cccccccccccccccccccccccccccccccc';
    const chunkDir = await writeChunkDir(fileHash, meta(fileHash, { updatedAt: recentTime }));

    const result = await createService().runCleanup();

    expect(await exists(chunkDir)).toBe(true);
    expect(result.skipped).toContainEqual({ fileHash, reason: 'not_expired' });
  });

  it('keeps chunk directories when lastAccessedAt is newer than updatedAt', async () => {
    const fileHash = 'dddddddddddddddddddddddddddddddd';
    const chunkDir = await writeChunkDir(fileHash, meta(fileHash, { updatedAt: oldTime, lastAccessedAt: recentTime }));

    await createService().runCleanup();

    expect(await exists(chunkDir)).toBe(true);
  });

  it('keeps MERGING chunk directories even when expired', async () => {
    const fileHash = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const chunkDir = await writeChunkDir(fileHash, meta(fileHash, { status: 'MERGING' }));

    const result = await createService().runCleanup();

    expect(await exists(chunkDir)).toBe(true);
    expect(result.skipped).toContainEqual({ fileHash, reason: 'merging' });
  });

  it('keeps directories currently locked by lockManager', async () => {
    const fileHash = 'ffffffffffffffffffffffffffffffff';
    const chunkDir = await writeChunkDir(fileHash, meta(fileHash));
    const isLocked = vi.fn((key: string) => key === fileHash);

    const result = await createService({ lockManager: { isLocked } }).runCleanup();

    expect(await exists(chunkDir)).toBe(true);
    expect(isLocked).toHaveBeenCalledWith(fileHash);
    expect(result.skipped).toContainEqual({ fileHash, reason: 'locked' });
  });

  it('logs and deletes expired abnormal directories that contain .part files but no meta.json', async () => {
    const fileHash = '11111111111111111111111111111111';
    const chunkDir = await writeChunkDir(fileHash);
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

    const result = await createService({
      logger,
      getDirectoryLastModifiedMs: vi.fn().mockResolvedValue(now.getTime() - expireMs - 1)
    }).runCleanup();

    expect(await exists(chunkDir)).toBe(false);
    expect(result.deleted).toEqual([fileHash]);
    expect(logger.error).toHaveBeenCalledWith('upload chunk metadata missing', { fileHash, chunkDir });
  });

  it('logs but keeps non-expired abnormal directories that contain .part files but no meta.json', async () => {
    const fileHash = '22222222222222222222222222222222';
    const chunkDir = await writeChunkDir(fileHash);
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

    await createService({
      logger,
      getDirectoryLastModifiedMs: vi.fn().mockResolvedValue(now.getTime())
    }).runCleanup();

    expect(await exists(chunkDir)).toBe(true);
    expect(logger.error).toHaveBeenCalledWith('upload chunk metadata missing', { fileHash, chunkDir });
  });
});
