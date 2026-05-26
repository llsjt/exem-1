export type ProgressPhase = 'hashing' | 'uploading';

export interface HashingProgressInput {
  loadedChunks: number;
  totalChunks: number;
}

export interface HashingProgress {
  phase: 'hashing';
  loadedChunks: number;
  totalChunks: number;
  percent: number;
}

export interface UploadProgressChunk {
  index: number;
  size: number;
}

export interface UploadProgressCalculatorOptions {
  totalFileSize: number;
  chunks: UploadProgressChunk[];
  uploadedChunks?: number[];
}

export interface UploadingProgress {
  phase: 'uploading';
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
  chunkUploadedBytes: Map<number, number>;
}

export function calculateHashingProgress(input: HashingProgressInput): HashingProgress {
  assertNonNegativeInteger(input.loadedChunks, 'loadedChunks');
  assertNonNegativeInteger(input.totalChunks, 'totalChunks');

  const loadedChunks = Math.min(input.loadedChunks, input.totalChunks);

  return {
    phase: 'hashing',
    loadedChunks,
    totalChunks: input.totalChunks,
    percent: calculatePercent(loadedChunks, input.totalChunks)
  };
}

export class UploadProgressCalculator {
  private readonly totalFileSize: number;
  private readonly chunkSizes = new Map<number, number>();
  private readonly chunkUploadedBytes = new Map<number, number>();

  constructor(options: UploadProgressCalculatorOptions) {
    assertNonNegativeInteger(options.totalFileSize, 'totalFileSize');

    this.totalFileSize = options.totalFileSize;

    // 进度按每个分片已上传字节数汇总，不用 completedChunks/totalChunks 粗略估算。
    for (const chunk of options.chunks) {
      assertNonNegativeInteger(chunk.index, 'chunk.index');
      assertNonNegativeInteger(chunk.size, 'chunk.size');

      if (this.chunkSizes.has(chunk.index)) {
        throw new Error(`Duplicate chunk index ${chunk.index}`);
      }

      this.chunkSizes.set(chunk.index, chunk.size);
      this.chunkUploadedBytes.set(chunk.index, 0);
    }

    if (options.uploadedChunks) {
      this.resumeFromUploadedChunks(options.uploadedChunks);
    }
  }

  updateChunkProgress(chunkIndex: number, uploadedBytes: number): UploadingProgress {
    const chunkSize = this.getChunkSize(chunkIndex);
    assertNonNegativeInteger(uploadedBytes, 'uploadedBytes');

    this.chunkUploadedBytes.set(chunkIndex, Math.min(uploadedBytes, chunkSize));
    return this.getProgress();
  }

  confirmChunkUploaded(chunkIndex: number): UploadingProgress {
    this.chunkUploadedBytes.set(chunkIndex, this.getChunkSize(chunkIndex));
    return this.getProgress();
  }

  resetChunkProgress(chunkIndex: number): UploadingProgress {
    this.getChunkSize(chunkIndex);
    this.chunkUploadedBytes.set(chunkIndex, 0);
    return this.getProgress();
  }

  resumeFromUploadedChunks(uploadedChunks: number[]): UploadingProgress {
    const confirmed = new Set(uploadedChunks);

    // 续传时只信任后端 status 返回的分片；未确认分片进度重置为 0。
    for (const chunkIndex of this.chunkSizes.keys()) {
      this.chunkUploadedBytes.set(chunkIndex, confirmed.has(chunkIndex) ? this.getChunkSize(chunkIndex) : 0);
    }

    return this.getProgress();
  }

  getChunkUploadedBytes(chunkIndex: number): number {
    this.getChunkSize(chunkIndex);
    return this.chunkUploadedBytes.get(chunkIndex) ?? 0;
  }

  getProgress(): UploadingProgress {
    const uploadedBytes = Array.from(this.chunkUploadedBytes.values()).reduce((sum, value) => sum + value, 0);

    return {
      phase: 'uploading',
      uploadedBytes,
      totalBytes: this.totalFileSize,
      percent: calculatePercent(uploadedBytes, this.totalFileSize),
      chunkUploadedBytes: new Map(this.chunkUploadedBytes)
    };
  }

  private getChunkSize(chunkIndex: number): number {
    const chunkSize = this.chunkSizes.get(chunkIndex);

    if (chunkSize === undefined) {
      throw new Error(`Unknown chunk index ${chunkIndex}`);
    }

    return chunkSize;
  }
}

function calculatePercent(loaded: number, total: number): number {
  if (total === 0) {
    return 0;
  }

  return (loaded / total) * 100;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}
