const STREAM_DELTA_RE = /^\[stream\]\s+([A-Za-z0-9+/=]+)$/;

export interface StreamDebugState {
  sawFirstToken: boolean;
  suppressedTokenCount: number;
}

export function createStreamDebugState(): StreamDebugState {
  return {
    sawFirstToken: false,
    suppressedTokenCount: 0,
  };
}

export function decodeStreamDelta(line: string): string | null {
  const match = line.match(STREAM_DELTA_RE);
  if (!match) return null;

  try {
    return Buffer.from(match[1], 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

function escapeStreamDebugToken(delta: string): string {
  return delta
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

export function consumeCollapsedStreamDebugLine(
  line: string,
  state: StreamDebugState,
  logLine: (line: string) => void,
): boolean {
  const delta = decodeStreamDelta(line);
  if (delta == null) {
    flushCollapsedStreamDebugSummary(state, logLine);
    return false;
  }

  if (!state.sawFirstToken) {
    state.sawFirstToken = true;
    logLine(`[stream] ${escapeStreamDebugToken(delta)}`);
  } else {
    state.suppressedTokenCount += 1;
  }

  return true;
}

export function flushCollapsedStreamDebugSummary(
  state: StreamDebugState,
  logLine: (line: string) => void,
): void {
  if (!state.sawFirstToken) return;
  logLine(`[stream] ${state.suppressedTokenCount} more tokens`);
  state.sawFirstToken = false;
  state.suppressedTokenCount = 0;
}
