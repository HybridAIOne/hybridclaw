import { describe, expect, it } from 'vitest';
import { categorize, rangeToSince, readRange } from './audit-filters';

describe('categorize', () => {
  it('returns the dot-prefix for a known category', () => {
    expect(categorize('session.end')).toBe('session');
    expect(categorize('tool.call')).toBe('tool');
    expect(categorize('autonomy.decision')).toBe('autonomy');
  });

  it("returns 'default' for unknown prefixes", () => {
    expect(categorize('unknown.event')).toBe('default');
    expect(categorize('')).toBe('default');
  });

  it("treats events with no dot as 'default' unless the full string is a category", () => {
    expect(categorize('session')).toBe('session');
    expect(categorize('plain')).toBe('default');
  });
});

describe('rangeToSince', () => {
  const now = Date.parse('2026-05-23T12:00:00.000Z');

  it("returns undefined when range is 'all'", () => {
    expect(rangeToSince('all', now)).toBeUndefined();
  });

  it('subtracts one hour for `1h`', () => {
    expect(rangeToSince('1h', now)).toBe('2026-05-23T11:00:00.000Z');
  });

  it('subtracts 24 hours for `24h`', () => {
    expect(rangeToSince('24h', now)).toBe('2026-05-22T12:00:00.000Z');
  });

  it('subtracts 7 days for `7d`', () => {
    expect(rangeToSince('7d', now)).toBe('2026-05-16T12:00:00.000Z');
  });
});

describe('readRange', () => {
  it('accepts the four known range values', () => {
    expect(readRange('all')).toBe('all');
    expect(readRange('1h')).toBe('1h');
    expect(readRange('24h')).toBe('24h');
    expect(readRange('7d')).toBe('7d');
  });

  it("falls back to 'all' for unknown or missing values", () => {
    expect(readRange(undefined)).toBe('all');
    expect(readRange('')).toBe('all');
    expect(readRange('30d')).toBe('all');
    expect(readRange('1H')).toBe('all');
  });
});
