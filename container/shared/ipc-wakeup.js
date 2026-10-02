/**
 * Advisory IPC directory wakeups shared by gateway and worker readers.
 * Subscribe before scanning; remember events until the next wait to avoid lost wakeups.
 * Files remain authoritative: this neither reads nor authenticates payloads.
 * Watch failures and missed events are covered by bounded reconciliation waits.
 */
import fs from 'node:fs';

// 1s (agent implementation decision, 2026-10-02): reconcile missed Docker/VM
// notifications without the former 20 scans/s; deployment-specific tuning deferred.
export const IPC_RECONCILE_INTERVAL_MS = 1_000;

export function createIpcWakeup(directory) {
  let pending = false;
  let closed = false;
  let finishWait;
  const wake = () => {
    pending = true;
    finishWait?.(false);
  };
  let watcher;
  try {
    // Watch the directory, since atomic replies replace the file's inode.
    // Filenames may be absent; all events are merely reasons to rescan.
    watcher = fs.watch(directory, { persistent: false }, wake);
    watcher.on('error', () => {
      watcher.close();
      wake();
    });
    watcher.on('close', wake);
  } catch {
    // Unsupported/unavailable watch: the caller still reconciles from disk.
  }

  return {
    wait(timeoutMs, signal) {
      if (signal?.aborted) return Promise.resolve(true);
      if (closed || pending) {
        pending = false;
        return Promise.resolve(false);
      }
      return new Promise((resolve) => {
        const finish = (aborted) => {
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
