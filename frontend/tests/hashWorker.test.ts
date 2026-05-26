import SparkMD5 from 'spark-md5';
import { describe, expect, it, vi } from 'vitest';
import {
  calculateFileHash,
  hashFileAndPostMessages,
  type HashWorkerOutgoingMessage
} from '../src/workers/hash.worker';
import { DEFAULT_CHUNK_SIZE } from '../src/utils/chunkFile';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function expectedMd5(bytes: Uint8Array): string {
  return SparkMD5.ArrayBuffer.hash(toArrayBuffer(bytes));
}

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('hash worker', () => {
  it('calculates the same MD5 for the same file across repeated runs', async () => {
    const content = textBytes('same content');
    const file = new File([toArrayBuffer(content)], 'same.txt');

    const firstHash = await calculateFileHash(file);
    const secondHash = await calculateFileHash(file);

    expect(firstHash).toBe(secondHash);
    expect(firstHash).toBe(expectedMd5(content));
  });

  it('calculates the MD5 for an empty file', async () => {
    const file = new File([], 'empty.bin');

    await expect(calculateFileHash(file)).resolves.toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('calculates the MD5 for a small file', async () => {
    const content = textBytes('small file content');
    const file = new File([toArrayBuffer(content)], 'small.txt');

    await expect(calculateFileHash(file)).resolves.toBe(expectedMd5(content));
  });

  it('reports progress and the final hash for a 5MB plus 1 byte file', async () => {
    const content = new Uint8Array(DEFAULT_CHUNK_SIZE + 1);
    content[DEFAULT_CHUNK_SIZE] = 1;
    const file = new File([toArrayBuffer(content)], 'large.bin');
    const messages: HashWorkerOutgoingMessage[] = [];

    await hashFileAndPostMessages(file, (message) => messages.push(message));

    expect(messages).toEqual([
      { type: 'progress', loadedChunks: 1, totalChunks: 2, percent: 50 },
      { type: 'progress', loadedChunks: 2, totalChunks: 2, percent: 100 },
      { type: 'done', fileHash: expectedMd5(content) }
    ]);
  });

  it('posts an error message when hash calculation fails', async () => {
    const brokenFile = {
      size: 1,
      slice: vi.fn(() => ({
        arrayBuffer: vi.fn(async () => {
          throw new Error('read failed');
        })
      }))
    } as unknown as File;
    const messages: HashWorkerOutgoingMessage[] = [];

    await hashFileAndPostMessages(brokenFile, (message) => messages.push(message));

    expect(messages).toEqual([{ type: 'error', message: 'read failed' }]);
  });
});
