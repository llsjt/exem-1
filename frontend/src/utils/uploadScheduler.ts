export interface UploadSchedulerSignal {
  readonly canceled: boolean;
  onCancel(callback: () => void): () => void;
  throwIfCanceled(): void;
}

export interface UploadSchedulerTask<T = unknown> {
  chunkIndex: number;
  run: (signal: UploadSchedulerSignal) => Promise<T>;
}

export interface UploadSchedulerOptions {
  concurrency?: number;
  onCancel?: () => void;
}

interface QueuedTask<T> {
  task: UploadSchedulerTask<T>;
  resultIndex: number;
}

interface RunState<T> {
  remaining: number;
  results: T[];
  resolve: (results: T[]) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

export class UploadSchedulerCanceledError extends Error {
  constructor() {
    super('Upload scheduler was canceled');
    this.name = 'UploadSchedulerCanceledError';
  }
}

export class UploadScheduler {
  private readonly concurrency: number;
  private readonly onCancel?: () => void;
  private readonly queue: QueuedTask<unknown>[] = [];
  private readonly activeSignals = new Set<UploadSchedulerTaskSignal>();
  private activeCount = 0;
  private paused = false;
  private canceled = false;
  private runState: RunState<unknown> | null = null;

  constructor(options: UploadSchedulerOptions = {}) {
    const concurrency = options.concurrency ?? 3;

    if (!Number.isInteger(concurrency) || concurrency <= 0) {
      throw new Error('concurrency must be a positive integer');
    }

    this.concurrency = concurrency;
    this.onCancel = options.onCancel;
  }

  get activeUploads(): number {
    return this.activeCount;
  }

  get queuedUploads(): number {
    return this.queue.length;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isCanceled(): boolean {
    return this.canceled;
  }

  run<T>(tasks: UploadSchedulerTask<T>[]): Promise<T[]> {
    if (this.runState) {
      return Promise.reject(new Error('Upload scheduler is already running'));
    }

    // 队列保存原始顺序，结果按 resultIndex 回填，避免并发完成顺序影响返回顺序。
    this.canceled = false;
    this.queue.length = 0;
    tasks.forEach((task, resultIndex) => {
      this.queue.push({ task, resultIndex } as QueuedTask<unknown>);
    });

    return new Promise<T[]>((resolve, reject) => {
      this.runState = {
        remaining: tasks.length,
        results: [],
        resolve: resolve as (results: unknown[]) => void,
        reject,
        settled: false
      };

      if (tasks.length === 0) {
        this.resolveRun();
        return;
      }

      this.dispatch();
    });
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (this.canceled) {
      return;
    }

    this.paused = false;
    this.dispatch();
  }

  cancel(): void {
    if (this.canceled) {
      return;
    }

    this.canceled = true;
    this.paused = false;
    this.queue.length = 0;

    // 取消时清空待派发队列，并通知所有运行中的任务中止对应 XHR。
    for (const signal of this.activeSignals) {
      signal.cancel();
    }

    this.onCancel?.();
    this.rejectRun(new UploadSchedulerCanceledError());
  }

  private dispatch(): void {
    // 自定义信号量：activeCount 小于 concurrency 时才继续派发新分片。
    while (!this.paused && !this.canceled && this.activeCount < this.concurrency && this.queue.length > 0) {
      const queued = this.queue.shift();

      if (!queued) {
        return;
      }

      this.startQueuedTask(queued);
    }

    if (!this.canceled && this.activeCount === 0 && this.queue.length === 0) {
      this.resolveRun();
    }
  }

  private startQueuedTask(queued: QueuedTask<unknown>): void {
    const signal = new UploadSchedulerTaskSignal();

    this.activeCount += 1;
    this.activeSignals.add(signal);

    queued.task
      .run(signal)
      .then((result) => {
        if (this.runState && !this.canceled) {
          this.runState.results[queued.resultIndex] = result;
        }
      })
      .catch((error) => {
        if (!this.canceled) {
          // 任一分片失败即停止继续派发，交给上层把任务置为 failed。
          this.canceled = true;
          this.queue.length = 0;
          this.rejectRun(error);
        }
      })
      .finally(() => {
        this.activeSignals.delete(signal);
        this.activeCount -= 1;

        if (this.runState && !this.runState.settled) {
          this.runState.remaining -= 1;
        }

        this.dispatch();
      });
  }

  private resolveRun(): void {
    if (!this.runState || this.runState.settled || this.runState.remaining > 0) {
      return;
    }

    const { resolve, results } = this.runState;
    this.runState.settled = true;
    this.runState = null;
    resolve(results);
  }

  private rejectRun(error: unknown): void {
    if (!this.runState || this.runState.settled) {
      return;
    }

    const { reject } = this.runState;
    this.runState.settled = true;
    this.runState = null;
    reject(error);
  }
}

class UploadSchedulerTaskSignal implements UploadSchedulerSignal {
  private cancelCallbacks = new Set<() => void>();
  private isCanceled = false;

  get canceled(): boolean {
    return this.isCanceled;
  }

  onCancel(callback: () => void): () => void {
    if (this.isCanceled) {
      callback();
      return () => undefined;
    }

    this.cancelCallbacks.add(callback);
    return () => {
      this.cancelCallbacks.delete(callback);
    };
  }

  throwIfCanceled(): void {
    if (this.isCanceled) {
      throw new UploadSchedulerCanceledError();
    }
  }

  cancel(): void {
    if (this.isCanceled) {
      return;
    }

    this.isCanceled = true;

    for (const callback of this.cancelCallbacks) {
      callback();
    }

    this.cancelCallbacks.clear();
  }
}
