export interface DiscoveryError {
  httpStatus?: number;
  message: string;
}

export function formatDiscoveryDuration(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

export function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  const name = error.name.toLowerCase();
  const code = (error as Error & { code?: unknown }).code;
  return (
    name === 'timeouterror' ||
    code === 23 ||
    code === 'TIMEOUT_ERR' ||
    /timed out|timeout|aborted due to timeout/.test(message)
  );
}

export function formatDiscoveryFailure(params: {
  error: unknown;
  url: string;
  timeoutMs: number;
}): DiscoveryError {
  const httpStatus = (params.error as { httpStatus?: number } | null)
    ?.httpStatus;
  if (typeof httpStatus === 'number') {
    return {
      httpStatus,
      message: `HTTP ${httpStatus} from ${params.url}`,
    };
  }

  if (isTimeoutError(params.error)) {
    return {
      message: `Timed out after ${formatDiscoveryDuration(
        params.timeoutMs,
      )} while fetching ${params.url}.`,
    };
  }

  const rawMessage =
    params.error instanceof Error && params.error.message.trim()
      ? params.error.message.trim()
      : String(params.error);
  return {
    message: `Failed to fetch ${params.url}: ${rawMessage}`,
  };
}
