/**
 * Advisory IPC directory wakeups shared by gateway and worker readers.
 * Subscribe before scanning; remember events until the next wait to avoid lost wakeups.
 * Files remain authoritative: this neither reads nor authenticates payloads.
 * Watch failures and missed events are covered by bounded reconciliation waits.
 */
import fs from 'node:fs';

/** One reader's wakeup handle; waits are sequential, never concurrent. */
export interface IpcWakeup {
  wait(timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  close(): void;
}

// 1s (agent implementation decision, 2026-10-02): reconcile missed Docker/VM
// notifications without the former 20 scans/s; deployment-specific tuning deferred.
export const IPC_RECONCILE_INTERVAL_MS = 1_000;

export function createIpcWakeup(directory: string): IpcWakeup {
  let pending = false;
  let closed = false;
  let finishWait: ((aborted: boolean) => void) | undefined;
  const wake = () => {
    pending = true;
    finishWait?.(false);
  };
  let watcher: fs.FSWatcher | undefined;
  try {
    // Watch the directory, since atomic replies replace the file's inode.
    // Filenames may be absent; all events are merely reasons to rescan.
    watcher = fs.watch(directory, { persistent: false }, wake);
    watcher.on('error', () => {
      watcher?.close();
      wake();
    });
    watcher.on('close', wake);
  } catch {
    // Unsupported/unavailable watch: the caller still reconciles from disk.
  }

  return {
    wait(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
      if (signal?.aborted) return Promise.resolve(true);
      if (closed || pending) {
        pending = false;
        return Promise.resolve(false);
      }
      return new Promise((resolve) => {
        const finish = (aborted: boolean) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          finishWait = undefined;
          pending = false;
          resolve(aborted);
        };
        const onAbort = () => finish(true);
        const timer = setTimeout(finish, timeoutMs, false);
        finishWait = finish;
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    close() {
      closed = true;
      watcher?.close();
      finishWait?.(false);
    },
  };
}
