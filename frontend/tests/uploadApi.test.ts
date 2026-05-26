import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkUpload,
  deleteUpload,
  getUploadStatus,
  mergeUpload,
  type CheckUploadRequest,
  type MergeUploadRequest
} from '../src/services/uploadApi';

describe('uploadApi', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends check requests as JSON to the upload check endpoint', async () => {
    const payload: CheckUploadRequest = {
      fileHash: '0123456789abcdef0123456789abcdef',
      fileName: 'video.mp4',
      fileSize: 1024,
      chunkSize: 256,
      totalChunks: 4,
      mimeType: 'video/mp4'
    };
    const response = { exists: false, uploadedChunks: [0, 2], fileUrl: null };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(response)
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(checkUpload(payload)).resolves.toEqual(response);

    expect(fetchMock).toHaveBeenCalledWith('/api/uploads/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  });

  it('sends status requests with an encoded file hash', async () => {
    const response = {
      fileHash: 'hash/with space',
      status: 'UPLOADING',
      uploadedChunks: [1]
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(response)
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getUploadStatus('hash/with space')).resolves.toEqual(response);

    expect(fetchMock).toHaveBeenCalledWith('/api/uploads/hash%2Fwith%20space/status', {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
  });

  it('sends merge requests as JSON to the merge endpoint', async () => {
    const payload: MergeUploadRequest = {
      fileHash: '0123456789abcdef0123456789abcdef',
      fileName: 'video.mp4',
      fileSize: 1024,
      totalChunks: 4,
      mimeType: 'video/mp4'
    };
    const response = {
      fileHash: payload.fileHash,
      fileName: payload.fileName,
      fileSize: payload.fileSize,
      status: 'MERGED',
      fileUrl: '/api/files/0123456789abcdef0123456789abcdef'
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(response)
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(mergeUpload(payload)).resolves.toEqual(response);

    expect(fetchMock).toHaveBeenCalledWith('/api/uploads/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  });

  it('sends delete requests to the upload cancel endpoint', async () => {
    const response = {
      fileHash: '0123456789abcdef0123456789abcdef',
      canceled: true
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(response)
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteUpload(response.fileHash)).resolves.toEqual(response);

    expect(fetchMock).toHaveBeenCalledWith('/api/uploads/0123456789abcdef0123456789abcdef', {
      method: 'DELETE',
      headers: { Accept: 'application/json' }
    });
  });
});
