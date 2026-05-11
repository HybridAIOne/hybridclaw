import { act, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ToastProvider } from '../components/toast';
import { useLiveConnectionToasts } from './use-live-connection-toasts';
import type { LiveConnection } from './use-live-events';

function wrapper({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

describe('useLiveConnectionToasts', () => {
  it('emits a paused toast when transitioning from open to error', () => {
    const { rerender } = renderHook(
      ({ c }: { c: LiveConnection }) => useLiveConnectionToasts(c),
      { wrapper, initialProps: { c: 'open' } },
    );
    expect(screen.queryByText('Live updates paused')).toBeNull();

    act(() => rerender({ c: 'error' }));
    expect(screen.getByText('Live updates paused')).toBeTruthy();
  });

  it('emits a restored toast and dismisses the paused toast on error -> open', () => {
    const { rerender } = renderHook(
      ({ c }: { c: LiveConnection }) => useLiveConnectionToasts(c),
      { wrapper, initialProps: { c: 'open' } },
    );
    act(() => rerender({ c: 'error' }));
    expect(screen.getByText('Live updates paused')).toBeTruthy();

    act(() => rerender({ c: 'open' }));
    expect(screen.getByText('Live updates restored')).toBeTruthy();
    expect(screen.queryByText('Live updates paused')).toBeNull();
  });

  it('still dismisses the paused toast on error -> connecting -> open (auth token change)', () => {
    const { rerender } = renderHook(
      ({ c }: { c: LiveConnection }) => useLiveConnectionToasts(c),
      { wrapper, initialProps: { c: 'open' } },
    );
    act(() => rerender({ c: 'error' }));
    expect(screen.getByText('Live updates paused')).toBeTruthy();

    act(() => rerender({ c: 'connecting' }));
    expect(screen.getByText('Live updates paused')).toBeTruthy();

    act(() => rerender({ c: 'open' }));
    expect(screen.getByText('Live updates restored')).toBeTruthy();
    expect(screen.queryByText('Live updates paused')).toBeNull();
  });

  it('does not emit on initial connecting -> open (page load)', () => {
    const { rerender } = renderHook(
      ({ c }: { c: LiveConnection }) => useLiveConnectionToasts(c),
      { wrapper, initialProps: { c: 'connecting' } },
    );
    act(() => rerender({ c: 'open' }));
    expect(screen.queryByText('Live updates paused')).toBeNull();
    expect(screen.queryByText('Live updates restored')).toBeNull();
  });

  it('does not emit on initial connecting -> error', () => {
    const { rerender } = renderHook(
      ({ c }: { c: LiveConnection }) => useLiveConnectionToasts(c),
      { wrapper, initialProps: { c: 'connecting' } },
    );
    act(() => rerender({ c: 'error' }));
    expect(screen.queryByText('Live updates paused')).toBeNull();
  });
});
