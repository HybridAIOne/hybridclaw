import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useFormDraft } from './use-form-draft';

type Config = { name: string; port: number };

describe('useFormDraft', () => {
  it('starts with draft = null while source is undefined', () => {
    const { result } = renderHook(() =>
      useFormDraft<Config>({ source: undefined }),
    );
    expect(result.current.draft).toBeNull();
    expect(result.current.isDirty).toBe(false);
  });

  it('hydrates draft once source becomes available', () => {
    const initialProps: { source: Config | undefined } = { source: undefined };
    const { result, rerender } = renderHook(
      ({ source }: { source: Config | undefined }) => useFormDraft({ source }),
      { initialProps },
    );
    expect(result.current.draft).toBeNull();
    rerender({ source: { name: 'gw', port: 9090 } });
    expect(result.current.draft).toEqual({ name: 'gw', port: 9090 });
    expect(result.current.isDirty).toBe(false);
  });

  it('reports isDirty true when draft and source diverge', () => {
    const source: Config = { name: 'gw', port: 9090 };
    const { result } = renderHook(() => useFormDraft({ source }));
    act(() => {
      result.current.setDraft({ name: 'gw', port: 8080 });
    });
    expect(result.current.isDirty).toBe(true);
  });

  it('discard reverts draft to the current source', () => {
    const source: Config = { name: 'gw', port: 9090 };
    const { result } = renderHook(() => useFormDraft({ source }));
    act(() => {
      result.current.setDraft({ name: 'gw', port: 8080 });
    });
    expect(result.current.isDirty).toBe(true);
    act(() => {
      result.current.discard();
    });
    expect(result.current.draft).toEqual(source);
    expect(result.current.isDirty).toBe(false);
  });

  it('commit overwrites draft with a new server-confirmed value', () => {
    const source: Config = { name: 'gw', port: 9090 };
    const { result } = renderHook(() => useFormDraft({ source }));
    act(() => {
      result.current.commit({ name: 'gw', port: 7070 });
    });
    expect(result.current.draft).toEqual({ name: 'gw', port: 7070 });
  });

  it('honors a custom equals predicate', () => {
    const source: Config = { name: 'gw', port: 9090 };
    const equals = (a: Config, b: Config) => a.port === b.port; // ignore name
    const { result } = renderHook(() => useFormDraft({ source, equals }));
    act(() => {
      result.current.setDraft({ name: 'changed', port: 9090 });
    });
    expect(result.current.isDirty).toBe(false);
    act(() => {
      result.current.setDraft({ name: 'changed', port: 1 });
    });
    expect(result.current.isDirty).toBe(true);
  });

  it('setField writes to a dotted path without mutating source', () => {
    type Nested = { ops: { healthPort: number; tags: string[] } };
    const source: Nested = { ops: { healthPort: 8080, tags: ['x'] } };
    const sourceOps = source.ops;
    const { result } = renderHook(() => useFormDraft({ source }));
    act(() => {
      result.current.setField('ops.healthPort', 9090);
    });
    expect(result.current.draft).toEqual({
      ops: { healthPort: 9090, tags: ['x'] },
    });
    expect(result.current.isDirty).toBe(true);
    expect(source.ops).toBe(sourceOps);
    expect(source.ops.healthPort).toBe(8080);
  });

  it('setField is a no-op while draft is null', () => {
    const { result } = renderHook(() =>
      useFormDraft<Config>({ source: undefined }),
    );
    expect(result.current.draft).toBeNull();
    act(() => {
      result.current.setField('port', 9090);
    });
    expect(result.current.draft).toBeNull();
  });

  it('re-hydrates draft when source changes and user has not edited', () => {
    const initial: Config = { name: 'gw', port: 9090 };
    const { result, rerender } = renderHook(
      ({ source }: { source: Config }) => useFormDraft({ source }),
      { initialProps: { source: initial } },
    );
    expect(result.current.draft).toEqual(initial);

    const refreshed: Config = { name: 'gw', port: 9091 };
    rerender({ source: refreshed });
    expect(result.current.draft).toEqual(refreshed);
    expect(result.current.isDirty).toBe(false);
  });

  it('ignores an equal-but-new source object instead of re-adopting in a loop', () => {
    // A caller that rebuilds an equal source every render (e.g.
    // `source: data ?? makeDefault()`) must not trip the re-hydration
    // effect: a clean draft + new identity would otherwise setDraft on
    // every render, looping forever. Comparison is by value, so an
    // equal-but-new source is a no-op and the draft reference is stable.
    const { result, rerender } = renderHook(
      ({ source }: { source: Config }) => useFormDraft({ source }),
      { initialProps: { source: { name: 'gw', port: 9090 } } },
    );
    const firstDraft = result.current.draft;
    rerender({ source: { name: 'gw', port: 9090 } });
    rerender({ source: { name: 'gw', port: 9090 } });
    expect(result.current.draft).toBe(firstDraft);
    expect(result.current.isDirty).toBe(false);
  });

  it('preserves draft edits when source changes underneath', () => {
    const initial: Config = { name: 'gw', port: 9090 };
    const { result, rerender } = renderHook(
      ({ source }: { source: Config }) => useFormDraft({ source }),
      { initialProps: { source: initial } },
    );
    act(() => {
      result.current.setField('port', 8080);
    });
    expect(result.current.draft).toEqual({ name: 'gw', port: 8080 });

    rerender({ source: { name: 'gw', port: 9091 } });
    expect(result.current.draft).toEqual({ name: 'gw', port: 8080 });
    expect(result.current.isDirty).toBe(true);
  });
});
