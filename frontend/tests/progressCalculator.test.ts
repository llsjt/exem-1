import { describe, expect, it } from 'vitest';
import {
  UploadProgressCalculator,
  calculateHashingProgress,
  type UploadProgressChunk
} from '../src/utils/progressCalculator';

const chunks: UploadProgressChunk[] = [
  { index: 0, size: 400 },
  { index: 1, size: 400 },
  { index: 2, size: 200 }
];

describe('progressCalculator', () => {
  it('keeps hashing progress separate from uploading progress', () => {
    expect(calculateHashingProgress({ loadedChunks: 2, totalChunks: 5 })).toEqual({
      phase: 'hashing',
      loadedChunks: 2,
      totalChunks: 5,
      percent: 40
    });
  });

  it('calculates uploading progress from uploaded bytes instead of completed chunk count', () => {
    const calculator = new UploadProgressCalculator({ totalFileSize: 1000, chunks });

    calculator.updateChunkProgress(0, 400);
    calculator.updateChunkProgress(1, 100);

    expect(calculator.getProgress()).toEqual({
      phase: 'uploading',
      uploadedBytes: 500,
      totalBytes: 1000,
      percent: 50,
      chunkUploadedBytes: new Map([
        [0, 400],
        [1, 100],
        [2, 0]
      ])
    });
  });

  it('marks confirmed uploaded chunks as full size and resets unconfirmed chunks on resume', () => {
    const calculator = new UploadProgressCalculator({ totalFileSize: 1000, chunks });

    calculator.updateChunkProgress(0, 300);
    calculator.updateChunkProgress(1, 250);
    calculator.resumeFromUploadedChunks([1]);

    expect(calculator.getProgress().uploadedBytes).toBe(400);
    expect(calculator.getChunkUploadedBytes(0)).toBe(0);
    expect(calculator.getChunkUploadedBytes(1)).toBe(400);
    expect(calculator.getChunkUploadedBytes(2)).toBe(0);
  });

  it('resets unconfirmed bytes for one chunk before retrying it', () => {
    const calculator = new UploadProgressCalculator({ totalFileSize: 1000, chunks });

    calculator.updateChunkProgress(0, 400);
    calculator.updateChunkProgress(1, 250);
    calculator.resetChunkProgress(1);

    expect(calculator.getProgress().uploadedBytes).toBe(400);
    expect(calculator.getChunkUploadedBytes(1)).toBe(0);
  });
});
