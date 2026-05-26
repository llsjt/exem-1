import SparkMD5 from 'spark-md5';
import { DEFAULT_CHUNK_SIZE } from '../utils/chunkFile';

export interface HashProgressMessage {
  type: 'progress';
  loadedChunks: number;
  totalChunks: number;
  percent: number;
}

export interface HashDoneMessage {
  type: 'done';
  fileHash: string;
}

export interface HashErrorMessage {
  type: 'error';
  message: string;
}

export type HashWorkerOutgoingMessage = HashProgressMessage | HashDoneMessage | HashErrorMessage;

export interface HashWorkerIncomingMessage {
  file: File;
  chunkSize?: number;
}

export interface CalculateFileHashOptions {
  chunkSize?: number;
  onProgress?: (message: HashProgressMessage) => void;
}

function assertChunkSize(chunkSize: number): void {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error('chunkSize must be a positive integer');
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  const blobWithArrayBuffer = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };

  if (typeof blobWithArrayBuffer.arrayBuffer === 'function') {
    return blobWithArrayBuffer.arrayBuffer();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
        return;
      }

      reject(new Error('Failed to read file chunk'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file chunk'));
    reader.readAsArrayBuffer(blob);
  });
}

export async function calculateFileHash(
  file: File,
  options: CalculateFileHashOptions = {}
): Promise<string> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  assertChunkSize(chunkSize);

  const spark = new SparkMD5.ArrayBuffer();
  const totalChunks = Math.ceil(file.size / chunkSize);

  // Worker 内按分片增量读取，避免大文件一次性进入内存。
  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const chunkBuffer = await readBlobAsArrayBuffer(file.slice(start, end));

    spark.append(chunkBuffer);

    const loadedChunks = index + 1;
    // Hash 进度按已读取分片数回传，上传进度由 XHR 单独计算，二者不混算。
    options.onProgress?.({
      type: 'progress',
      loadedChunks,
      totalChunks,
      percent: Math.round((loadedChunks / totalChunks) * 100)
    });
  }

  return spark.end();
}

export async function hashFileAndPostMessages(
  file: File,
  postMessage: (message: HashWorkerOutgoingMessage) => void,
  chunkSize = DEFAULT_CHUNK_SIZE
): Promise<void> {
  try {
    const fileHash = await calculateFileHash(file, {
      chunkSize,
      onProgress: postMessage
    });

    postMessage({ type: 'done', fileHash });
  } catch (error) {
    postMessage({ type: 'error', message: toErrorMessage(error) });
  }
}

const workerGlobal = globalThis as unknown as {
  addEventListener?: (type: 'message', listener: (event: MessageEvent<HashWorkerIncomingMessage>) => void) => void;
  postMessage?: (message: HashWorkerOutgoingMessage) => void;
};

if (typeof window === 'undefined' && typeof workerGlobal.addEventListener === 'function') {
  workerGlobal.addEventListener('message', (event) => {
    const { file, chunkSize } = event.data;

    // Worker 只负责计算指纹并发消息，具体上传编排交给 uploadStore/uploadScheduler。
    void hashFileAndPostMessages(file, (message) => workerGlobal.postMessage?.(message), chunkSize);
  });
}
