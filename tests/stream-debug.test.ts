import { describe, expect, it } from 'vitest';

import {
  consumeCollapsedStreamDebugLine,
  createStreamDebugState,
  decodeStreamDelta,
  decodeThinkingDelta,
  flushCollapsedStreamDebugSummary,
  isThinkingDeltaLine,
} from '../src/infra/stream-debug.ts';

function encode(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
}

describe('stream debug logging', () => {
  it('decodes stream transport lines', () => {
    expect(decodeStreamDelta(`[stream] ${encode('Hey')}`)).toBe('Hey');
    expect(decodeStreamDelta('[codex] stream complete')).toBeNull();
  });

  it('identifies out-of-band thinking transport lines', () => {
    const line = `[thinking] ${encode('checking')}`;

    expect(decodeThinkingDelta(line)).toBe('checking');
    expect(isThinkingDeltaLine(line)).toBe(true);
    expect(isThinkingDeltaLine(`[stream] ${encode('visible')}`)).toBe(false);
  });

  it('logs the first token and a final summary only', () => {
    const state = createStreamDebugState();
    const lines: string[] = [];

    expect(
      consumeCollapsedStreamDebugLine(
        `[stream] ${encode('Hey')}`,
        state,
        (line) => lines.push(line),
      ),
    ).toBe(true);
    expect(
      consumeCollapsedStreamDebugLine(
        `[stream] ${encode(' Ben')}`,
        state,
        (line) => lines.push(line),
      ),
    ).toBe(true);
    expect(
      consumeCollapsedStreamDebugLine(
        `[stream] ${encode('.')}`,
        state,
        (line) => lines.push(line),
      ),
    ).toBe(true);
    expect(
      consumeCollapsedStreamDebugLine(
        '[codex] stream complete',
        state,
        (line) => lines.push(line),
      ),
    ).toBe(false);

    expect(lines).toEqual(['[stream] Hey', '[stream] 2 more tokens']);
  });

  it('escapes embedded newlines to keep stream debug output on one line', () => {
    const state = createStreamDebugState();
    const lines: string[] = [];

    consumeCollapsedStreamDebugLine(
      `[stream] ${encode('line 1\nline 2')}`,
      state,
      (line) => lines.push(line),
    );
    flushCollapsedStreamDebugSummary(state, (line) => lines.push(line));

    expect(lines).toEqual([
      '[stream] line 1\\nline 2',
      '[stream] 0 more tokens',
    ]);
  });
});
