import { describe, expect, test } from 'vitest';

import {
  parseOutputVerbosity,
  stripVerbosityFlags,
} from '../src/cli/verbosity.js';

describe('parseOutputVerbosity', () => {
  test('defaults to standard when no flag is passed', () => {
    expect(parseOutputVerbosity([])).toBe('standard');
    expect(parseOutputVerbosity(['some-id', '--json'])).toBe('standard');
  });

  test('returns quiet for --quiet or -q', () => {
    expect(parseOutputVerbosity(['--quiet'])).toBe('quiet');
    expect(parseOutputVerbosity(['-q'])).toBe('quiet');
  });

  test('returns all for --all', () => {
    expect(parseOutputVerbosity(['--all'])).toBe('all');
  });

  test('last verbosity flag wins when multiple are passed', () => {
    expect(parseOutputVerbosity(['--quiet', '--all'])).toBe('all');
    expect(parseOutputVerbosity(['--all', '-q'])).toBe('quiet');
  });
});

describe('stripVerbosityFlags', () => {
  test('removes --quiet, -q, and --all but preserves everything else', () => {
    expect(
      stripVerbosityFlags(['session-1', '--quiet', '--json', '-q', '--all']),
    ).toEqual(['session-1', '--json']);
  });

  test('returns the same args when no verbosity flag present', () => {
    expect(stripVerbosityFlags(['session-1', '--json'])).toEqual([
      'session-1',
      '--json',
    ]);
  });
});
