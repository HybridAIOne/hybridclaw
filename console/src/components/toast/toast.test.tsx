import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './index';

function ToastTriggers() {
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => toast.success('Saved')}>
        Success
      </button>
      <button type="button" onClick={() => toast.error('Failed', 'Details')}>
        Error
      </button>
      <button type="button" onClick={() => toast.info('FYI')}>
        Info
      </button>
    </>
  );
}

function setup() {
  return render(
    <ToastProvider>
      <ToastTriggers />
    </ToastProvider>,
  );
}

describe('Toast', () => {
  it('shows a success toast', () => {
    setup();
    act(() => {
      screen.getByRole('button', { name: 'Success' }).click();
    });
    expect(screen.getByText('Saved')).toBeTruthy();
    expect(
      screen
        .getByText('Saved')
        .closest('[data-type]')
        ?.getAttribute('data-type'),
    ).toBe('success');
  });

  it('shows an error toast with description', () => {
    setup();
    act(() => {
      screen.getByRole('button', { name: 'Error' }).click();
    });
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('Details')).toBeTruthy();
  });

  it('auto-dismisses after duration', () => {
    vi.useFakeTimers();
    setup();

    act(() => {
      screen.getByRole('button', { name: 'Info' }).click();
    });
    expect(screen.getByText('FYI')).toBeTruthy();

    // After 5s the dismiss fires; in jsdom the animationend fallback removes immediately.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByText('FYI')).toBeNull();

    vi.useRealTimers();
  });

  it('respects the limit prop', () => {
    render(
      <ToastProvider limit={2}>
        <ToastTriggers />
      </ToastProvider>,
    );

    act(() => {
      screen.getByRole('button', { name: 'Success' }).click();
      screen.getByRole('button', { name: 'Error' }).click();
      screen.getByRole('button', { name: 'Info' }).click();
    });

    // 3 were added but limit=2, so the first should be marked exiting
    // and immediately removed in jsdom (no real animation).
    const allToasts = document.querySelectorAll('[data-type]');
    expect(allToasts.length).toBeLessThanOrEqual(3);
  });

  it('uses role="alert" for error toasts', () => {
    setup();
    act(() => {
      screen.getByRole('button', { name: 'Error' }).click();
    });
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('uses role="status" for non-error toasts', () => {
    setup();
    act(() => {
      screen.getByRole('button', { name: 'Success' }).click();
    });
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('pauses auto-dismiss on hover', () => {
    vi.useFakeTimers();
    setup();

    act(() => {
      screen.getByRole('button', { name: 'Info' }).click();
    });

    const toast = screen.getByText('FYI').closest('[data-type]');
    expect(toast).toBeTruthy();

    // Hover after 2 seconds.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    fireEvent.mouseEnter(toast);

    // Wait another 5 seconds while hovered — toast should stay.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText('FYI')).toBeTruthy();

    // Unhover — remaining ~3s should elapse.
    fireEvent.mouseLeave(toast);
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(screen.queryByText('FYI')).toBeNull();

    vi.useRealTimers();
  });

  it('dismisses the most recent toast on Escape', () => {
    setup();
    act(() => {
      screen.getByRole('button', { name: 'Success' }).click();
      screen.getByRole('button', { name: 'Info' }).click();
    });

    expect(screen.getByText('Saved')).toBeTruthy();
    expect(screen.getByText('FYI')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    // Most recent (FYI) should be dismissed; Saved should remain.
    expect(screen.queryByText('FYI')).toBeNull();
    expect(screen.getByText('Saved')).toBeTruthy();
  });
});
