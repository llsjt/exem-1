import { describe, expect, it, vi } from 'vitest';
import { createUploadStore, type UploadTaskStatus, type UploadWorkflowDependencies } from '../src/stores/uploadStore';

function makeFile(name = 'exam.mp4', size = 1024): File {
  return new File([new Uint8Array(size)], name, { type: 'video/mp4' });
}

describe('upload store', () => {
  it('adds selected files as hashing tasks with file metadata', () => {
    const store = createUploadStore({ autoStart: false });
    const file = makeFile('paper.pdf', 2048);

    const [task] = store.addFiles([file]);

    expect(store.tasks).toHaveLength(1);
    expect(task).toMatchObject({
      file,
      fileName: 'paper.pdf',
      fileSize: 2048,
      mimeType: 'video/mp4',
      status: 'hashing',
      progress: 0
    });
  });

  it('supports the upload task status vocabulary required by phase 9', () => {
    const expected: UploadTaskStatus[] = [
      'hashing',
      'uploading',
      'paused',
      'failed',
      'merging',
      'success',
      'canceled'
    ];

    expect(createUploadStore({ autoStart: false }).statuses).toEqual(expected);
  });

  it('pauses and resumes an active task without losing progress', () => {
    const store = createUploadStore({ autoStart: false, mockRunner: true });
    const [task] = store.addFiles([makeFile()]);

    store.setTaskStatus(task.id, 'uploading');
    store.setTaskProgress(task.id, 42);
    store.pauseTask(task.id);

    expect(task.status).toBe('paused');
    expect(task.progress).toBe(42);

    store.resumeTask(task.id);

    expect(task.status).toBe('uploading');
    expect(task.progress).toBe(42);
  });

  it('cancels non-terminal tasks and prevents later progress changes', () => {
    const store = createUploadStore({ autoStart: false });
    const [task] = store.addFiles([makeFile()]);

    store.setTaskStatus(task.id, 'uploading');
    store.cancelTask(task.id);
    store.setTaskProgress(task.id, 90);
    store.resumeTask(task.id);

    expect(task.status).toBe('canceled');
    expect(task.progress).toBe(0);
  });

  it('mock-runs hashing, uploading, merging, and success when autoStart is enabled', () => {
    vi.useFakeTimers();
    const store = createUploadStore({ autoStart: true, mockRunner: true, timerIntervalMs: 10 });

    const [task] = store.addFiles([makeFile()]);

    vi.advanceTimersByTime(20);
    expect(task.status).toBe('hashing');
    expect(task.progress).toBeGreaterThan(0);

    vi.advanceTimersByTime(100);
    expect(task.status).toBe('uploading');

    vi.advanceTimersByTime(100);
    expect(task.status).toBe('merging');

    vi.advanceTimersByTime(20);
    expect(task.status).toBe('success');
    expect(task.progress).toBe(100);

    store.dispose();
    vi.useRealTimers();
  });

  it('runs the real upload workflow from hash to merge when dependencies are provided', async () => {
    const uploadedChunks: number[] = [];
    const dependencies: UploadWorkflowDependencies = {
      hashFile: vi.fn(async (_file, options) => {
        options.onProgress?.({ type: 'progress', loadedChunks: 1, totalChunks: 1, percent: 100 });
        return 'dddddddddddddddddddddddddddddddd';
      }),
      checkUpload: vi.fn().mockResolvedValue({ exists: false, uploadedChunks: [], fileUrl: null }),
      getUploadStatus: vi.fn(),
      uploadChunk: vi.fn(async (request, options) => {
        uploadedChunks.push(request.chunkIndex);
        options.onProgress?.({
          chunkIndex: request.chunkIndex,
          loaded: request.chunk.size,
          total: request.chunk.size,
          percent: 100
        });
        return { chunkIndex: request.chunkIndex, uploaded: true };
      }),
      mergeUpload: vi.fn().mockResolvedValue({
        fileHash: 'dddddddddddddddddddddddddddddddd',
        fileName: 'exam.mp4',
        fileSize: 8,
        mimeType: 'video/mp4',
        status: 'MERGED',
        fileUrl: '/api/files/dddddddddddddddddddddddddddddddd'
      }),
      deleteUpload: vi.fn()
    };
    const store = createUploadStore({ autoStart: false, chunkSize: 4, dependencies });
    const [task] = store.addFiles([makeFile('exam.mp4', 8)]);

    await store.startTask(task.id);

    expect(task.status).toBe('success');
    expect(task.progress).toBe(100);
    expect(task.fileHash).toBe('dddddddddddddddddddddddddddddddd');
    expect(uploadedChunks).toEqual([0, 1]);
    expect(dependencies.mergeUpload).toHaveBeenCalledWith(expect.objectContaining({
      fileHash: 'dddddddddddddddddddddddddddddddd',
      totalChunks: 2
    }));
  });

  it('marks instant uploads as success without sending chunks', async () => {
    const dependencies: UploadWorkflowDependencies = {
      hashFile: vi.fn().mockResolvedValue('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
      checkUpload: vi.fn().mockResolvedValue({
        exists: true,
        uploadedChunks: [],
        fileUrl: '/api/files/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      }),
      getUploadStatus: vi.fn(),
      uploadChunk: vi.fn(),
      mergeUpload: vi.fn(),
      deleteUpload: vi.fn()
    };
    const store = createUploadStore({ autoStart: false, dependencies });
    const [task] = store.addFiles([makeFile()]);

    await store.startTask(task.id);

    expect(task.status).toBe('success');
    expect(task.message).toBe('秒传成功');
    expect(dependencies.uploadChunk).not.toHaveBeenCalled();
    expect(dependencies.mergeUpload).not.toHaveBeenCalled();
  });

  it('resumes failed tasks by querying status and uploading only missing chunks', async () => {
    const uploadedChunks: number[] = [];
    const dependencies: UploadWorkflowDependencies = {
      hashFile: vi.fn().mockResolvedValue('ffffffffffffffffffffffffffffffff'),
      checkUpload: vi.fn().mockResolvedValue({ exists: false, uploadedChunks: [0], fileUrl: null }),
      getUploadStatus: vi.fn().mockResolvedValue({
        fileHash: 'ffffffffffffffffffffffffffffffff',
        status: 'UPLOADING',
        uploadedChunks: [0]
      }),
      uploadChunk: vi.fn(async (request) => {
        uploadedChunks.push(request.chunkIndex);
        return { chunkIndex: request.chunkIndex, uploaded: true };
      }),
      mergeUpload: vi.fn().mockResolvedValue({
        fileHash: 'ffffffffffffffffffffffffffffffff',
        fileName: 'exam.mp4',
        fileSize: 8,
        mimeType: 'video/mp4',
        status: 'MERGED',
        fileUrl: '/api/files/ffffffffffffffffffffffffffffffff'
      }),
      deleteUpload: vi.fn()
    };
    const store = createUploadStore({ autoStart: false, chunkSize: 4, dependencies });
    const [task] = store.addFiles([makeFile('exam.mp4', 8)]);

    task.fileHash = 'ffffffffffffffffffffffffffffffff';
    store.setTaskStatus(task.id, 'failed');
    await store.resumeTask(task.id);

    expect(dependencies.getUploadStatus).toHaveBeenCalledWith('ffffffffffffffffffffffffffffffff');
    expect(uploadedChunks).toEqual([1]);
  });
});
