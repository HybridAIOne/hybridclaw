export declare function encodeWarmWorkerFrame<T>(
  mcpServers: Record<string, T>,
): string;

export declare function readWarmWorkerFrame(
  value: unknown,
): Record<string, unknown> | null;
