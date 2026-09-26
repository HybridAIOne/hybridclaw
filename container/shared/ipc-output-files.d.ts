export declare const LEGACY_IPC_OUTPUT_FILE: 'output.json';

export declare function ipcOutputFileName(
  requestId: string | undefined,
): string;

export declare function isIpcOutputFileName(name: string): boolean;
