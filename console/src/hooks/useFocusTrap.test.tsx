import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { type RefObject, useCallback, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FocusGuard } from './FocusGuard';
import { useFocusTrap } from './useFocusTrap';

function TrapHarness(props: { active: boolean; explicitInitial?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const preferred = useRef<HTMLButtonElement>(null);
  useFocusTrap(
    ref as RefObject<HTMLElement>,
    props.active,
    props.explicitInitial ? preferred : undefined,
  );
  return (
    <div ref={ref} data-testid="trap">
      <button type="button">First</button>
      <button type="button">Second</button>
      <button type="button" ref={preferred}>
        Third
      </button>
    </div>
  );
}

function SentinelHarness() {
  const trapRef = useRef<HTMLDivElement>(null);
  const focusFirst = useCallback(() => {
    trapRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);
  return (
    <div>
      <div ref={trapRef} data-testid="trap">
        <button type="button">First</button>
        <button type="button">Second</button>
        <button type="button">Third</button>
      </div>
      <FocusGuard onFocus={focusFirst} />
    </div>
  );
}

function ToggleHarness() {
  const [active, setActive] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="outside"
        onClick={() => setActive(true)}
      >
        Outside
      </button>
      <TrapHarness active={active} />
      <button
        type="button"
        data-testid="deactivate"
        onClick={() => setActive(false)}
      >
        Deactivate
      </button>
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useFocusTrap', () => {
  it.each([false, true])(
    'preserves a focus choice made before the deferred callback, explicit target: %s',
    (explicitInitial) => {
      let initialize: FrameRequestCallback | undefined;
      vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
        (callback) => {
          initialize = callback;
          return 123;
        },
      );
      vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
      const { getByRole } = render(
        <TrapHarness active={true} explicitInitial={explicitInitial} />,
      );
      const chosen = getByRole('button', { name: 'Second' });
      chosen.focus();
      expect(initialize).toBeTypeOf('function');
      act(() => initialize?.(0));
      expect(document.activeElement).toBe(chosen);
    },
  );

  it.each([false, true])(
    'sets default focus when focus remains outside, explicit target: %s',
    (explicitInitial) => {
      let initialize: FrameRequestCallback | undefined;
      vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
        (callback) => {
          initialize = callback;
          return 123;
        },
      );
      vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
      const { getByRole } = render(
        <TrapHarness active={true} explicitInitial={explicitInitial} />,
      );
      expect(initialize).toBeTypeOf('function');
      act(() => initialize?.(0));
      expect(document.activeElement).toBe(
        getByRole('button', { name: explicitInitial ? 'Third' : 'First' }),
      );
    },
  );

  it('wraps Tab from last element to first', async () => {
    render(<TrapHarness active={true} />);
    // Let the rAF initial focus run
    await new Promise((r) => requestAnimationFrame(r));

    const buttons = document.querySelectorAll<HTMLElement>(
      '[data-testid="trap"] button',
    );
    const last = buttons[buttons.length - 1];
    last.focus();
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('wraps Shift+Tab from first element to last', async () => {
    render(<TrapHarness active={true} />);
    await new Promise((r) => requestAnimationFrame(r));

    const buttons = document.querySelectorAll<HTMLElement>(
      '[data-testid="trap"] button',
    );
    const first = buttons[0];
    first.focus();

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it('restores focus to previously focused element on deactivation', async () => {
    render(<ToggleHarness />);
    const outside = document.querySelector<HTMLElement>(
      '[data-testid="outside"]',
    );
    expect(outside).not.toBeNull();
    outside?.focus();
    expect(document.activeElement).toBe(outside);

    // Activate trap
    fireEvent.click(outside as HTMLElement);
    await new Promise((r) => requestAnimationFrame(r));

    // Focus should have moved inside the trap
    const trap = document.querySelector('[data-testid="trap"]');
    expect(trap).not.toBeNull();
    expect(trap?.contains(document.activeElement)).toBe(true);

    // Deactivate trap — focus should return to the outside button
    const deactivate = document.querySelector<HTMLElement>(
      '[data-testid="deactivate"]',
    );
    expect(deactivate).not.toBeNull();
    fireEvent.click(deactivate as HTMLElement);
    expect(document.activeElement).toBe(outside);
  });

  it('FocusGuard sentinel redirects focus when its onFocus callback moves focus', async () => {
    // Render a trap container with a FocusGuard sentinel rendered after the
    // content (simulating the post-content sentinel that catches Tab past the
    // last element and redirects focus back to the first). Wire onFocus to a
    // real focus action so we can assert focus actually moves.
    const { container } = render(<SentinelHarness />);
    await new Promise((r) => requestAnimationFrame(r));

    const sentinel = container.querySelector<HTMLElement>('span[aria-hidden]');
    expect(sentinel).not.toBeNull();
    const firstButton = container.querySelector<HTMLElement>(
      '[data-testid="trap"] button',
    );
    expect(firstButton).not.toBeNull();

    fireEvent.focus(sentinel as HTMLElement);
    expect(document.activeElement).toBe(firstButton);
  });
});
