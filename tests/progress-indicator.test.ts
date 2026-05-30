import { afterEach, describe, expect, test, vi } from 'vitest';

import { startProgressIndicator } from '../src/infra/progress-indicator.ts';

function fakeStream(isTTY: boolean): {
  stream: NodeJS.WriteStream;
  writes: string[];
} {
  const writes: string[] = [];
  const stream = {
    isTTY,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, writes };
}

describe('startProgressIndicator', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test('prints plain start and result lines on a non-interactive stream (no ANSI)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { stream, writes } = fakeStream(false);

    const indicator = startProgressIndicator('Setting up the agent runtime…', stream);
    indicator.succeed('Agent runtime ready.');

    // No ANSI/animation is written to the stream...
    expect(writes).toEqual([]);
    // ...but a plain start breadcrumb and the result line are logged.
    expect(logSpy).toHaveBeenNthCalledWith(1, 'Setting up the agent runtime…');
    expect(logSpy).toHaveBeenNthCalledWith(2, 'Agent runtime ready.');
    expect(logSpy).toHaveBeenCalledTimes(2);
  });

  test('animates a spinner and clears the line on an interactive stream', () => {
    // The test runner disables animation via VITEST; clear it for this case.
    vi.stubEnv('VITEST', '');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { stream, writes } = fakeStream(true);

    const indicator = startProgressIndicator('Updating the agent runtime…', stream);
    // The first frame renders synchronously on start.
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[0]).toContain('Updating the agent runtime…');

    indicator.succeed('Agent runtime ready.');
    // The spinner line is cleared before the result line is printed.
    expect(writes[writes.length - 1]).toContain('\x1b[2K');
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Agent runtime ready.'),
    );
  });

  test('routes failures to console.warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { stream } = fakeStream(false);

    startProgressIndicator('Setting up the agent runtime…', stream).fail(
      'Could not set up the agent runtime.',
    );

    expect(warnSpy).toHaveBeenCalledWith('Could not set up the agent runtime.');
  });

  test('is idempotent once finished', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { stream } = fakeStream(false);

    const indicator = startProgressIndicator('Setting up the agent runtime…', stream);
    indicator.succeed('Agent runtime ready.');
    indicator.succeed('ignored');
    indicator.fail('ignored');
    indicator.clear();

    // One start line + exactly one result line; later finish calls are no-ops.
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenLastCalledWith('Agent runtime ready.');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
