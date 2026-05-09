import { act, renderHook, screen } from '@testing-library/react';
import { type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ToastProvider } from '../components/toast';
import { useLiveConnectionToasts } from './use-live-connection-toasts';

type Connection = 'idle' | 'connecting' | 'open' | 'error';

function wrapper({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

describe('useLiveConnectionToasts', () => {
  it('emits a paused toast when transitioning from open to error', () => {
    const { rerender } = renderHook(
      ({ c }: { c: Connection }) => useLiveConnectionToasts(c),
      { wrapper, initialProps: { c: 'open' } },
    );
    expect(screen.queryByText('Live updates paused')).toBeNull();

    act(() => rerender({ c: 'error' }));
    expect(screen.getByText('Live updates paused')).toBeTruthy();
  });

  it('emits a restored toast when transitioning from error back to open', () => {
    const { rerender } = renderHook(
      ({ c }: { c: Connection }) => useLiveConnectionToasts(c),
      { wrapper, initialProps: { c: 'open' } },
    );
    act(() => rerender({ c: 'error' }));
    act(() => rerender({ c: 'open' }));
    expect(screen.getByText('Live updates restored')).toBeTruthy();
  });

  it('does not emit on initial connecting -> open (page load)', () => {
    const { rerender } = renderHook(
      ({ c }: { c: Connection }) => useLiveConnectionToasts(c),
      { wrapper, initialProps: { c: 'connecting' } },
    );
    act(() => rerender({ c: 'open' }));
    expect(screen.queryByText('Live updates paused')).toBeNull();
    expect(screen.queryByText('Live updates restored')).toBeNull();
  });

  it('does not emit on initial connecting -> error', () => {
    const { rerender } = renderHook(
      ({ c }: { c: Connection }) => useLiveConnectionToasts(c),
      { wrapper, initialProps: { c: 'connecting' } },
    );
    act(() => rerender({ c: 'error' }));
    expect(screen.queryByText('Live updates paused')).toBeNull();
  });
});
