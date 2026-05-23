import { describe, expect, it } from 'vitest';
import { categorize, readRange, withinRange } from './audit-filters';

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

describe('withinRange', () => {
  const now = Date.parse('2026-05-23T12:00:00Z');

  it("includes everything when range is 'all'", () => {
    expect(withinRange('1990-01-01T00:00:00Z', 'all', now)).toBe(true);
    expect(withinRange('not-a-date', 'all', now)).toBe(true);
  });

  it('includes timestamps within the last hour', () => {
    expect(withinRange('2026-05-23T11:30:00Z', '1h', now)).toBe(true);
    expect(withinRange('2026-05-23T10:59:59Z', '1h', now)).toBe(false);
  });

  it('includes timestamps within 24 hours', () => {
    expect(withinRange('2026-05-22T12:00:01Z', '24h', now)).toBe(true);
    expect(withinRange('2026-05-22T11:59:59Z', '24h', now)).toBe(false);
  });

  it('includes timestamps within 7 days', () => {
    expect(withinRange('2026-05-16T12:00:00Z', '7d', now)).toBe(true);
    expect(withinRange('2026-05-15T23:59:59Z', '7d', now)).toBe(false);
  });

  it('excludes unparsable timestamps when range is set', () => {
    expect(withinRange('not-a-date', '24h', now)).toBe(false);
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
