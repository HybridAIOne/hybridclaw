const STREAM_DELTA_RE = /^\[stream\]\s+([A-Za-z0-9+/=]+)$/;
const THINKING_DELTA_RE = /^\[thinking\]\s+([A-Za-z0-9+/=]+)$/;
const STREAM_ACTIVITY_RE = /^\[stream-activity\]$/;

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
  return decodeBase64Line(line, STREAM_DELTA_RE);
}

export function decodeThinkingDelta(line: string): string | null {
  return decodeBase64Line(line, THINKING_DELTA_RE);
}

export function isThinkingDeltaLine(line: string): boolean {
  return THINKING_DELTA_RE.test(line);
}

function decodeBase64Line(line: string, pattern: RegExp): string | null {
  const match = line.match(pattern);
  if (!match) return null;

  try {
    return Buffer.from(match[1], 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

export function decodeThinkingDelta(line: string): string | null {
  const match = line.match(THINKING_DELTA_RE);
  if (!match) return null;

  try {
    return Buffer.from(match[1], 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

export function isThinkingDeltaLine(line: string): boolean {
  return THINKING_DELTA_RE.test(line);
}

export function isStreamActivityLine(line: string): boolean {
  return STREAM_ACTIVITY_RE.test(line);
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
