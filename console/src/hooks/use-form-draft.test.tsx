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
});
