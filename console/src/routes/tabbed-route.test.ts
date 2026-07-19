import { describe, expect, it } from 'vitest';
import { mergeRouteSearch, readRouteTab } from './tabbed-route';

describe('tabbed route helpers', () => {
  const tabs = [{ id: 'one' }, { id: 'two' }] as const;

  it('accepts known tabs and falls back for unknown values', () => {
    expect(readRouteTab('two', tabs, 'one')).toBe('two');
    expect(readRouteTab('missing', tabs, 'one')).toBe('one');
  });

  it('preserves unrelated URL state while replacing a tab value', () => {
    expect(
      mergeRouteSearch(
        { range: '30d', q: 'tool', tab: undefined as string | undefined },
        { tab: 'audit' },
      ),
    ).toEqual({ range: '30d', q: 'tool', tab: 'audit' });
  });
});
