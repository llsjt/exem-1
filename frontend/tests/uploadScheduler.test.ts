import { describe, expect, it, vi } from 'vitest';
import {
  UploadScheduler,
  UploadSchedulerCanceledError,
  type UploadSchedulerTask
} from '../src/utils/uploadScheduler';

const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function createControlledTask(index: number, onStart: () => void) {
  let resolveTask!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveTask = resolve;
  });

  const task: UploadSchedulerTask<number> = {
    chunkIndex: index,
    run: async () => {
      onStart();
      await done;
      return index;
    }
  };

  return { task, resolveTask };
}

describe('UploadScheduler', () => {
  it('limits active chunk uploads to three at the same time', async () => {
    let active = 0;
    let maxActive = 0;
    const controls = Array.from({ length: 6 }, (_, index) =>
      createControlledTask(index, () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
      })
    );
    const scheduler = new UploadScheduler({ concurrency: 3 });

    const run = scheduler.run(controls.map(({ task }) => ({
      ...task,
      run: async (signal) => {
        const result = await task.run(signal);
        active -= 1;
        return result;
      }
    })));
    await flushMicrotasks();

    expect(maxActive).toBe(3);

    controls.forEach(({ resolveTask }) => resolveTask());
    await expect(run).resolves.toEqual([0, 1, 2, 3, 4, 5]);
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it('does not dispatch queued chunks while paused', async () => {
    const started: number[] = [];
    const first = createControlledTask(0, () => started.push(0));
    const second: UploadSchedulerTask<number> = {
      chunkIndex: 1,
      run: async () => {
        started.push(1);
        return 1;
      }
    };
    const scheduler = new UploadScheduler({ concurrency: 1 });

    const run = scheduler.run([first.task, second]);
    await flushMicrotasks();
    scheduler.pause();
    first.resolveTask();
    await flushMicrotasks();

    expect(started).toEqual([0]);

    scheduler.resume();
    await expect(run).resolves.toEqual([0, 1]);
    expect(started).toEqual([0, 1]);
  });

  it('cancels queued work and notifies active task listeners', async () => {
    const onCancel = vi.fn();
    const taskCancel = vi.fn();
    const scheduler = new UploadScheduler({ concurrency: 1, onCancel });
    const first = createControlledTask(0, () => undefined);
    const second: UploadSchedulerTask<number> = {
      chunkIndex: 1,
      run: async () => 1
    };
    const task: UploadSchedulerTask<number> = {
      chunkIndex: 0,
      run: async (signal) => {
        signal.onCancel(taskCancel);
        return first.task.run(signal);
      }
    };

    const run = scheduler.run([task, second]);
    await flushMicrotasks();
    scheduler.cancel();
    first.resolveTask();

    await expect(run).rejects.toBeInstanceOf(UploadSchedulerCanceledError);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(taskCancel).toHaveBeenCalledTimes(1);
  });
});
