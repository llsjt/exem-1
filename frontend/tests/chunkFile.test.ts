import { describe, expect, it } from 'vitest';
import { DEFAULT_CHUNK_SIZE, chunkFile } from '../src/utils/chunkFile';

describe('chunkFile', () => {
  it('creates one chunk for an empty file', () => {
    const file = new File([], 'empty.bin');

    expect(chunkFile(file)).toEqual([
      {
        index: 0,
        start: 0,
        end: 0,
        size: 0,
        blob: file.slice(0, 0)
      }
    ]);
  });

  it('uses File.slice and keeps the last chunk size accurate', () => {
    const size = DEFAULT_CHUNK_SIZE + 1;
    const file = new File([new Uint8Array(size)], 'large.bin');

    const chunks = chunkFile(file);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ index: 0, start: 0, end: DEFAULT_CHUNK_SIZE, size: DEFAULT_CHUNK_SIZE });
    expect(chunks[1]).toMatchObject({ index: 1, start: DEFAULT_CHUNK_SIZE, end: size, size: 1 });
  });
});

