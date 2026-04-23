import { describe, expect, it } from 'vitest';
import {
  getArg,
  normalizeArg,
  parseIdArg,
  parseIntegerArg,
  parseLowerArg,
} from '../src/command-parsing.js';

describe('command parsing', () => {
  it('normalizes indexed command args', () => {
    const args = [' Command ', '  VALUE  '];

    expect(getArg(args, 0)).toBe(' Command ');
    expect(parseLowerArg(args, 0)).toBe('command');
    expect(parseIdArg(args, 1)).toBe('VALUE');
  });

  it('supports defaults and required arguments', () => {
    expect(parseLowerArg([], 1, { defaultValue: 'List' })).toBe('list');
    expect(() => parseIdArg([], 1, { required: true })).toThrow(
      'Missing required command argument',
    );
  });

  it('parses integer command args', () => {
    expect(parseIntegerArg(['task', ' 42 '], 1)).toBe(42);
    expect(parseIntegerArg(['task', 'abc'], 1)).toBeNull();
    expect(parseIntegerArg(['task'], 1)).toBeNull();
  });

  it('normalizes standalone values used while scanning command flags', () => {
    expect(normalizeArg('  --FORCE  ', { trim: true, lower: true })).toBe(
      '--force',
    );
  });
});
