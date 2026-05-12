export interface TuiRunStopParams<T> {
  abortController: AbortController | null;
  stopRequest: Promise<T> | null;
  requestStop: () => Promise<T>;
  clearStopRequest: () => void;
}

export function stopTuiRun<T>(params: TuiRunStopParams<T>): Promise<T> | null {
  if (params.stopRequest) return params.stopRequest;
  if (!params.abortController || params.abortController.signal.aborted) {
    return null;
  }

  const stopRequest = params.requestStop().finally(params.clearStopRequest);
  params.abortController.abort();
  return stopRequest;
}
