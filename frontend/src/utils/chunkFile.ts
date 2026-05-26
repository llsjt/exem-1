export const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;

export interface FileChunk {
  index: number;
  start: number;
  end: number;
  size: number;
  blob: Blob;
}

export function chunkFile(file: File, chunkSize = DEFAULT_CHUNK_SIZE): FileChunk[] {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error('chunkSize must be a positive integer');
  }

  if (file.size === 0) {
    return [{ index: 0, start: 0, end: 0, size: 0, blob: file.slice(0, 0) }];
  }

  const totalChunks = Math.ceil(file.size / chunkSize);
  const chunks: FileChunk[] = [];

  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    chunks.push({
      index,
      start,
      end,
      size: end - start,
      blob: file.slice(start, end)
    });
  }

  return chunks;
}

