import { constants } from 'node:fs';
import { access, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { uploadConfig, type UploadConfig } from '../config/uploadConfig.js';
import { uploadLockManager } from '../storage/lockManager.js';
import type { UploadMeta } from '../types/uploadTypes.js';

type CleanupSkipReason = 'not_expired' | 'merging' | 'locked' | 'missing_meta_without_parts';

export interface CleanupConfig {
  chunksRoot: string;
  filesRoot?: string;
  chunkExpireHours: number;
  cleanupCron?: string;
}

export interface CleanupLogger {
  error(message: string, details?: unknown): void;
  warn?(message: string, details?: unknown): void;
  info?(message: string, details?: unknown): void;
}

export interface CleanupLockManager {
  isLocked(fileHash: string): boolean;
}

export interface CleanupSkip {
  fileHash: string;
  reason: CleanupSkipReason;
}

export interface CleanupRunResult {
  scanned: number;
  deleted: string[];
  skipped: CleanupSkip[];
}

export interface CleanupService {
  runCleanup(): Promise<CleanupRunResult>;
}

export interface CleanupCronTask {
  start(): void;
  stop(): void;
}

export interface CleanupServiceOptions {
  config?: CleanupConfig | Pick<UploadConfig, 'chunksRoot' | 'filesRoot' | 'chunkExpireHours' | 'cleanupCron'>;
  lockManager?: CleanupLockManager;
  logger?: CleanupLogger;
  now?: () => Date;
  getDirectoryLastModifiedMs?: (directoryPath: string) => Promise<number>;
}

const PART_FILE_PATTERN = /^\d+\.part$/;
const HOURS_TO_MS = 60 * 60 * 1000;
const require = createRequire(import.meta.url);

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultGetDirectoryLastModifiedMs(directoryPath: string): Promise<number> {
  const directoryStat = await stat(directoryPath);
  return directoryStat.mtimeMs;
}

function parseTimeMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function getMetaActivityMs(meta: UploadMeta): number | null {
  const updatedAtMs = parseTimeMs(meta.updatedAt);
  const lastAccessedAtMs = parseTimeMs(meta.lastAccessedAt);

  if (updatedAtMs === null) {
    return lastAccessedAtMs;
  }

  if (lastAccessedAtMs === null) {
    return updatedAtMs;
  }

  return Math.max(updatedAtMs, lastAccessedAtMs);
}

async function readUploadMeta(metaPath: string): Promise<UploadMeta | null> {
  try {
    return JSON.parse(await readFile(metaPath, 'utf8')) as UploadMeta;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

async function hasPartFile(chunkDir: string): Promise<boolean> {
  const entries = await readdir(chunkDir, { withFileTypes: true });
  return entries.some((entry) => entry.isFile() && PART_FILE_PATTERN.test(entry.name));
}

function isExpired(activityMs: number, nowMs: number, expireMs: number): boolean {
  return nowMs - activityMs > expireMs;
}

export function createCleanupService(options: CleanupServiceOptions = {}): CleanupService {
  const config = options.config ?? uploadConfig;
  const lockManager = options.lockManager ?? uploadLockManager;
  const logger = options.logger ?? console;
  const now = options.now ?? (() => new Date());
  const getDirectoryLastModifiedMs = options.getDirectoryLastModifiedMs ?? defaultGetDirectoryLastModifiedMs;
  const expireMs = config.chunkExpireHours * HOURS_TO_MS;

  return {
    async runCleanup() {
      const result: CleanupRunResult = {
        scanned: 0,
        deleted: [],
        skipped: []
      };

      if (!(await pathExists(config.chunksRoot))) {
        return result;
      }

      const entries = await readdir(config.chunksRoot, { withFileTypes: true });
      const nowMs = now().getTime();

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const fileHash = entry.name;
        const chunkDir = path.join(config.chunksRoot, fileHash);
        result.scanned += 1;

        if (lockManager.isLocked(fileHash)) {
          result.skipped.push({ fileHash, reason: 'locked' });
          continue;
        }

        const metaPath = path.join(chunkDir, 'meta.json');
        const uploadMeta = await readUploadMeta(metaPath);

        if (uploadMeta?.status === 'MERGING') {
          result.skipped.push({ fileHash, reason: 'merging' });
          continue;
        }

        let activityMs = uploadMeta ? getMetaActivityMs(uploadMeta) : null;

        if (!uploadMeta) {
          if (!(await hasPartFile(chunkDir))) {
            result.skipped.push({ fileHash, reason: 'missing_meta_without_parts' });
            continue;
          }

          logger.error('upload chunk metadata missing', { fileHash, chunkDir });
          activityMs = await getDirectoryLastModifiedMs(chunkDir);
        }

        if (activityMs === null) {
          activityMs = await getDirectoryLastModifiedMs(chunkDir);
        }

        if (!isExpired(activityMs, nowMs, expireMs)) {
          result.skipped.push({ fileHash, reason: 'not_expired' });
          continue;
        }

        await rm(chunkDir, { recursive: true, force: true });
        result.deleted.push(fileHash);
      }

      return result;
    }
  };
}

export const cleanupService = createCleanupService();

export function startCleanupCron(service: CleanupService = cleanupService, config: CleanupConfig = uploadConfig): CleanupCronTask {
  const nodeCron = require('node-cron') as {
    schedule(expression: string, task: () => void): CleanupCronTask;
  };

  return nodeCron.schedule(config.cleanupCron ?? uploadConfig.cleanupCron, () => {
    void service.runCleanup();
  });
}
