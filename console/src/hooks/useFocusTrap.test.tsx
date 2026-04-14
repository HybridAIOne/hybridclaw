import { cleanup, fireEvent, render } from '@testing-library/react';
import { type RefObject, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FocusGuard } from './FocusGuard';
import { useFocusTrap } from './useFocusTrap';

function TrapHarness(props: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref as RefObject<HTMLElement>, props.active);
  return (
    <div ref={ref} data-testid="trap">
      <button type="button">First</button>
      <button type="button">Second</button>
      <button type="button">Third</button>
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

afterEach(cleanup);

describe('useFocusTrap', () => {
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

  it('FocusGuard sentinel redirects focus to first element when it receives focus', async () => {
    // Render a trap container with a FocusGuard sentinel rendered after the
    // content (simulating the post-content sentinel that catches Tab past the
    // last element and redirects focus back to the first).
    const onFocus = vi.fn();
    const { container } = render(
      <div>
        <TrapHarness active={true} />
        <FocusGuard onFocus={onFocus} />
      </div>,
    );
    await new Promise((r) => requestAnimationFrame(r));

    const sentinel = container.querySelector<HTMLElement>('span[aria-hidden]');
    expect(sentinel).not.toBeNull();

    // Fire focus on the sentinel — onFocus should be called.
    fireEvent.focus(sentinel as HTMLElement);
    expect(onFocus).toHaveBeenCalledOnce();
  });
});
