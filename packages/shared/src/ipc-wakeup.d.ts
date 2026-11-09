export declare const IPC_RECONCILE_INTERVAL_MS: number;

/** One reader's wakeup handle; waits are sequential, never concurrent. */
export interface IpcWakeup {
  wait(timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  close(): void;
}

export declare function createIpcWakeup(directory: string): IpcWakeup;
