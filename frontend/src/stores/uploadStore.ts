import { reactive } from 'vue';
import { calculateFileHash, type HashProgressMessage } from '../workers/hash.worker';
import { chunkFile, DEFAULT_CHUNK_SIZE, type FileChunk } from '../utils/chunkFile';
import { UploadProgressCalculator } from '../utils/progressCalculator';
import { UploadScheduler, UploadSchedulerCanceledError } from '../utils/uploadScheduler';
import {
  checkUpload,
  deleteUpload,
  getUploadStatus,
  mergeUpload,
  type CheckUploadRequest,
  type CheckUploadResponse,
  type MergeUploadRequest,
  type MergeUploadResponse,
  type UploadStatusResponse
} from '../services/uploadApi';
import {
  ChunkUploadAbortedError,
  XhrUploadClient,
  type ChunkUploadRequest,
  type ChunkUploadResponse,
  type UploadChunkOptions
} from '../services/xhrUploadClient';

export const UPLOAD_TASK_STATUSES = [
  'hashing',
  'uploading',
  'paused',
  'failed',
  'merging',
  'success',
  'canceled'
] as const;

export type UploadTaskStatus = (typeof UPLOAD_TASK_STATUSES)[number];

export interface UploadTask {
  id: string;
  file: File;
  fileName: string;
  fileSize: number;
  mimeType: string;
  fileHash?: string;
  fileUrl?: string;
  status: UploadTaskStatus;
  progress: number;
  message: string;
  createdAt: number;
  updatedAt: number;
  previousActiveStatus?: Extract<UploadTaskStatus, 'hashing' | 'uploading' | 'merging'>;
}

export interface CreateUploadStoreOptions {
  autoStart?: boolean;
  mockRunner?: boolean;
  timerIntervalMs?: number;
  progressStep?: number;
  chunkSize?: number;
  concurrency?: number;
  dependencies?: UploadWorkflowDependencies;
  now?: () => number;
}

type ActiveStatus = Extract<UploadTaskStatus, 'hashing' | 'uploading' | 'merging'>;
type TimerHandle = ReturnType<typeof setInterval>;

export interface HashFileOptions {
  chunkSize?: number;
  onProgress?: (message: HashProgressMessage) => void;
}

export interface UploadWorkflowDependencies {
  hashFile(file: File, options: HashFileOptions): Promise<string>;
  checkUpload(payload: CheckUploadRequest): Promise<CheckUploadResponse>;
  getUploadStatus(fileHash: string): Promise<UploadStatusResponse>;
  uploadChunk(request: ChunkUploadRequest, options: UploadChunkOptions): Promise<ChunkUploadResponse>;
  mergeUpload(payload: MergeUploadRequest): Promise<MergeUploadResponse>;
  deleteUpload(fileHash: string): Promise<unknown>;
}

interface ActiveWorkflow {
  scheduler?: UploadScheduler;
  client?: XhrUploadClient;
}

const TERMINAL_STATUSES = new Set<UploadTaskStatus>(['success', 'canceled']);

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) {
    return 0;
  }

  return Math.min(100, Math.max(0, Math.round(progress)));
}

function statusMessage(status: UploadTaskStatus): string {
  const messages: Record<UploadTaskStatus, string> = {
    hashing: '正在计算文件指纹',
    uploading: '正在上传分片',
    paused: '已暂停',
    failed: '上传失败',
    merging: '正在合并分片',
    success: '上传完成',
    canceled: '已取消'
  };

  return messages[status];
}

export function createUploadStore(options: CreateUploadStoreOptions = {}) {
  const autoStart = options.autoStart ?? true;
  const mockRunner = options.mockRunner ?? false;
  const timerIntervalMs = options.timerIntervalMs ?? 500;
  const progressStep = options.progressStep ?? 10;
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const concurrency = options.concurrency ?? 3;
  const dependencies = options.dependencies ?? createDefaultWorkflowDependencies();
  const now = options.now ?? (() => Date.now());
  const tasks = reactive<UploadTask[]>([]);
  const timers = new Map<string, TimerHandle>();
  const activeWorkflows = new Map<string, ActiveWorkflow>();
  let nextId = 1;

  function findTask(taskId: string): UploadTask | undefined {
    return tasks.find((task) => task.id === taskId);
  }

  function touch(task: UploadTask): void {
    task.updatedAt = now();
  }

  function clearTimer(taskId: string): void {
    const timer = timers.get(taskId);

    if (timer) {
      clearInterval(timer);
      timers.delete(taskId);
    }
  }

  function canChangeTask(task: UploadTask): boolean {
    return !TERMINAL_STATUSES.has(task.status);
  }

  function setTaskStatus(taskId: string, status: UploadTaskStatus, message = statusMessage(status)): void {
    const task = findTask(taskId);

    if (!task || (TERMINAL_STATUSES.has(task.status) && task.status !== status)) {
      return;
    }

    task.status = status;
    task.message = message;

    if (status === 'success') {
      task.progress = 100;
      clearTimer(taskId);
    }

    if (status === 'canceled' || status === 'failed' || status === 'paused') {
      clearTimer(taskId);
    }

    touch(task);
  }

  function setTaskProgress(taskId: string, progress: number): void {
    const task = findTask(taskId);

    if (!task || !canChangeTask(task)) {
      return;
    }

    task.progress = clampProgress(progress);
    touch(task);
  }

  function tickTask(taskId: string): void {
    const task = findTask(taskId);

    if (!task || !canChangeTask(task)) {
      clearTimer(taskId);
      return;
    }

    if (task.status === 'hashing') {
      task.progress = clampProgress(task.progress + progressStep);

      if (task.progress >= 100) {
        task.status = 'uploading';
        task.progress = 0;
        task.message = statusMessage('uploading');
        task.previousActiveStatus = 'uploading';
      }

      touch(task);
      return;
    }

    if (task.status === 'uploading') {
      task.progress = clampProgress(task.progress + progressStep);

      if (task.progress >= 100) {
        task.status = 'merging';
        task.progress = 95;
        task.message = statusMessage('merging');
        task.previousActiveStatus = 'merging';
      }

      touch(task);
      return;
    }

    if (task.status === 'merging') {
      task.progress = clampProgress(task.progress + Math.max(1, Math.ceil(progressStep / 5)));

      if (task.progress >= 100) {
        setTaskStatus(task.id, 'success');
        return;
      }

      touch(task);
    }
  }

  function startMockRunner(taskId: string): void {
    const task = findTask(taskId);

    if (!autoStart || !mockRunner || !task || TERMINAL_STATUSES.has(task.status) || timers.has(taskId)) {
      return;
    }

    timers.set(taskId, setInterval(() => tickTask(taskId), timerIntervalMs));
  }

  function addFiles(files: Iterable<File> | FileList): UploadTask[] {
    const addedTasks = Array.from(files).map((file) => {
      const timestamp = now();
      const task: UploadTask = {
        id: `upload-${timestamp}-${nextId}`,
        file,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        status: 'hashing',
        progress: 0,
        message: statusMessage('hashing'),
        createdAt: timestamp,
        updatedAt: timestamp,
        previousActiveStatus: 'hashing'
      };

      nextId += 1;
      tasks.unshift(task);

      if (autoStart) {
        if (mockRunner) {
          startMockRunner(task.id);
        } else {
          void startTask(task.id);
        }
      }

      return task;
    });

    return addedTasks;
  }

  function pauseTask(taskId: string): void {
    const task = findTask(taskId);

    if (!task || !['hashing', 'uploading'].includes(task.status)) {
      return;
    }

    task.previousActiveStatus = task.status as ActiveStatus;
    activeWorkflows.get(taskId)?.scheduler?.cancel();
    activeWorkflows.get(taskId)?.client?.abortAll();
    setTaskStatus(taskId, 'paused');
  }

  function resumeTask(taskId: string): Promise<void> | void {
    const task = findTask(taskId);

    if (!task || !['paused', 'failed'].includes(task.status)) {
      return;
    }

    if (mockRunner) {
      const nextStatus = task.previousActiveStatus ?? 'uploading';
      task.status = nextStatus;
      task.message = statusMessage(nextStatus);
      touch(task);
      startMockRunner(taskId);
      return;
    }

    return startTask(taskId, { resume: true });
  }

  function cancelTask(taskId: string): void {
    const task = findTask(taskId);

    if (!task || task.status === 'success' || task.status === 'canceled') {
      return;
    }

    activeWorkflows.get(taskId)?.scheduler?.cancel();
    activeWorkflows.get(taskId)?.client?.abortAll();

    if (task.fileHash) {
      void dependencies.deleteUpload(task.fileHash).catch(() => undefined);
    }

    activeWorkflows.delete(taskId);
    setTaskStatus(taskId, 'canceled');
  }

  function failTask(taskId: string, message = statusMessage('failed')): void {
    const task = findTask(taskId);

    if (!task || TERMINAL_STATUSES.has(task.status)) {
      return;
    }

    setTaskStatus(taskId, 'failed', message);
  }

  function dispose(): void {
    Array.from(timers.keys()).forEach(clearTimer);
    for (const workflow of activeWorkflows.values()) {
      workflow.scheduler?.cancel();
      workflow.client?.abortAll();
    }
    activeWorkflows.clear();
  }

  async function startTask(taskId: string, runOptions: { resume?: boolean } = {}): Promise<void> {
    const task = findTask(taskId);

    if (!task || TERMINAL_STATUSES.has(task.status)) {
      return;
    }

    clearTimer(taskId);

    try {
      // 主流程：先拿 fileHash，再 check 秒传/续传状态，最后补传缺失分片并触发 merge。
      const fileHash = task.fileHash ?? await hashTaskFile(task);
      task.fileHash = fileHash;

      const chunks = chunkFile(task.file, chunkSize);
      const basePayload = toRequestPayload(task, fileHash, chunks);
      let uploadedChunks = runOptions.resume && fileHash
        ? (await dependencies.getUploadStatus(fileHash)).uploadedChunks
        : [];

      if (uploadedChunks.length === 0) {
        // 非恢复场景先走 check；如果后端已有正式文件，前端直接秒传成功。
        const check = await dependencies.checkUpload(basePayload);

        if (check.exists) {
          task.fileUrl = check.fileUrl ?? undefined;
          setTaskStatus(taskId, 'success', '秒传成功');
          return;
        }

        uploadedChunks = check.uploadedChunks;
      }

      await uploadMissingChunks(task, chunks, uploadedChunks, basePayload);
      setTaskStatus(taskId, 'merging');

      const merged = await dependencies.mergeUpload({
        fileHash,
        fileName: task.fileName,
        fileSize: task.fileSize,
        mimeType: task.mimeType,
        totalChunks: chunks.length
      });

      task.fileUrl = merged.fileUrl;
      setTaskStatus(taskId, 'success');
    } catch (error) {
      if (error instanceof UploadSchedulerCanceledError || error instanceof ChunkUploadAbortedError) {
        return;
      }

      failTask(taskId, error instanceof Error ? error.message : statusMessage('failed'));
    } finally {
      activeWorkflows.delete(taskId);
    }
  }

  async function hashTaskFile(task: UploadTask): Promise<string> {
    task.status = 'hashing';
    task.message = statusMessage('hashing');
    task.progress = 0;
    touch(task);

    // Hash 阶段只更新指纹计算进度，上传字节进度在 uploadMissingChunks 中维护。
    return dependencies.hashFile(task.file, {
      chunkSize,
      onProgress(progress) {
        task.progress = clampProgress(progress.percent);
        touch(task);
      }
    });
  }

  async function uploadMissingChunks(
    task: UploadTask,
    chunks: FileChunk[],
    uploadedChunks: number[],
    basePayload: CheckUploadRequest
  ): Promise<void> {
    task.status = 'uploading';
    task.message = statusMessage('uploading');
    task.previousActiveStatus = 'uploading';

    const client = options.dependencies ? undefined : new XhrUploadClient();
    const scheduler = new UploadScheduler({
      concurrency,
      onCancel: () => client?.abortAll()
    });
    activeWorkflows.set(task.id, { scheduler, client });

    const calculator = new UploadProgressCalculator({
      totalFileSize: task.fileSize,
      chunks: chunks.map((chunk) => ({ index: chunk.index, size: chunk.size })),
      uploadedChunks
    });
    task.progress = clampProgress(calculator.getProgress().percent);

    const uploaded = new Set(uploadedChunks);
    const pendingChunks = chunks.filter((chunk) => !uploaded.has(chunk.index));

    // 只调度后端尚未确认的分片，支撑暂停/失败后的断点续传。
    await scheduler.run(pendingChunks.map((chunk) => ({
      chunkIndex: chunk.index,
      run: async (signal) => {
        signal.throwIfCanceled();
        const unsubscribe = client ? signal.onCancel(() => client.abortChunk(chunk.index)) : () => undefined;

        try {
          // 每个分片的 onProgress 写入计算器，再汇总为整个文件的真实上传进度。
          const response = await (client
            ? client.uploadChunk(toChunkRequest(basePayload, chunk), {
                onProgress(progress) {
                  const total = calculator.updateChunkProgress(progress.chunkIndex, progress.loaded);
                  task.progress = clampProgress(total.percent);
                  touch(task);
                }
              })
            : dependencies.uploadChunk(toChunkRequest(basePayload, chunk), {
                onProgress(progress) {
                  const total = calculator.updateChunkProgress(progress.chunkIndex, progress.loaded);
                  task.progress = clampProgress(total.percent);
                  touch(task);
                }
              }));

          const total = calculator.confirmChunkUploaded(chunk.index);
          task.progress = clampProgress(total.percent);
          touch(task);
          return response;
        } catch (error) {
          calculator.resetChunkProgress(chunk.index);
          throw error;
        } finally {
          unsubscribe();
        }
      }
    })));
  }

  return {
    statuses: UPLOAD_TASK_STATUSES,
    tasks,
    addFiles,
    startTask,
    setTaskStatus,
    setTaskProgress,
    pauseTask,
    resumeTask,
    cancelTask,
    failTask,
    dispose
  };
}

export const uploadStore = createUploadStore();

function createDefaultWorkflowDependencies(): UploadWorkflowDependencies {
  const client = new XhrUploadClient();

  return {
    hashFile: calculateFileHash,
    checkUpload,
    getUploadStatus,
    uploadChunk: (request, uploadOptions) => client.uploadChunk(request, uploadOptions),
    mergeUpload,
    deleteUpload
  };
}

function toRequestPayload(task: UploadTask, fileHash: string, chunks: FileChunk[]): CheckUploadRequest {
  return {
    fileHash,
    fileName: task.fileName,
    fileSize: task.fileSize,
    mimeType: task.mimeType,
    chunkSize: chunks.length === 0 ? DEFAULT_CHUNK_SIZE : chunks[0].size || DEFAULT_CHUNK_SIZE,
    totalChunks: chunks.length
  };
}

function toChunkRequest(payload: CheckUploadRequest, chunk: FileChunk): ChunkUploadRequest {
  return {
    fileHash: payload.fileHash,
    fileName: payload.fileName,
    fileSize: payload.fileSize,
    chunkSize: payload.chunkSize,
    totalChunks: payload.totalChunks,
    chunkIndex: chunk.index,
    mimeType: payload.mimeType,
    chunk: chunk.blob
  };
}
