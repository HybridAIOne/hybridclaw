import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './index';

// jsdom does not implement the Web Animations API.
// Polyfill getAnimations so useAnimationsFinished works in the Toast component.
if (!HTMLElement.prototype.getAnimations) {
  HTMLElement.prototype.getAnimations = () => [];
}

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
      <button
        type="button"
        onClick={() =>
          toast.add({
            title: 'With action',
            action: {
              label: 'Undo',
              onClick: () => document.dispatchEvent(new Event('test-action')),
            },
          })
        }
      >
        Action
      </button>
      <button
        type="button"
        onClick={() => toast.add({ title: 'Persistent', duration: 0 })}
      >
        Sticky
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
  it('throws when useToast is called outside ToastProvider', () => {
    function Bare() {
      useToast();
      return null;
    }
    expect(() => render(<Bare />)).toThrow(
      'useToast must be used within <ToastProvider>.',
    );
  });

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

    // 3 were added but limit=2. In jsdom the exit animation fallback fires
    // immediately, so the overflow toast is removed synchronously.
    const allToasts = document.querySelectorAll('[data-type]');
    expect(allToasts.length).toBe(2);
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

    const toast = screen.getByText('FYI').closest('[data-type]') as Element;
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

  it('dismisses the most recent toast on Escape when viewport is focused', () => {
    setup();
    act(() => {
      screen.getByRole('button', { name: 'Success' }).click();
      screen.getByRole('button', { name: 'Info' }).click();
    });

    expect(screen.getByText('Saved')).toBeTruthy();
    expect(screen.getByText('FYI')).toBeTruthy();

    // Focus the toast viewport (simulates pressing F8).
    const viewport = screen.getByText('FYI').closest('[tabindex="-1"]');
    expect(viewport).toBeTruthy();
    act(() => (viewport as HTMLElement).focus());

    fireEvent.keyDown(document, { key: 'Escape' });

    // Most recent (FYI) should be dismissed; Saved should remain.
    expect(screen.queryByText('FYI')).toBeNull();
    expect(screen.getByText('Saved')).toBeTruthy();
  });

  it('does not dismiss toast on Escape when focus is elsewhere', () => {
    setup();
    act(() => {
      screen.getByRole('button', { name: 'Success' }).click();
    });

    expect(screen.getByText('Saved')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByText('Saved')).toBeTruthy();
  });

  it('dismisses a toast when the close button is clicked', () => {
    setup();
    act(() => {
      screen.getByRole('button', { name: 'Success' }).click();
    });
    expect(screen.getByText('Saved')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('fires the action callback and dismisses', () => {
    const handler = vi.fn();
    document.addEventListener('test-action', handler);

    setup();
    act(() => {
      screen.getByRole('button', { name: 'Action' }).click();
    });
    expect(screen.getByText('With action')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(handler).toHaveBeenCalledOnce();
    expect(screen.queryByText('With action')).toBeNull();

    document.removeEventListener('test-action', handler);
  });

  it('error toasts do not auto-dismiss', () => {
    vi.useFakeTimers();
    setup();

    act(() => {
      screen.getByRole('button', { name: 'Error' }).click();
    });
    expect(screen.getByText('Failed')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText('Failed')).toBeTruthy();

    vi.useRealTimers();
  });

  it('does not auto-dismiss when duration is 0', () => {
    vi.useFakeTimers();
    setup();

    act(() => {
      screen.getByRole('button', { name: 'Sticky' }).click();
    });
    expect(screen.getByText('Persistent')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText('Persistent')).toBeTruthy();

    vi.useRealTimers();
  });
});
