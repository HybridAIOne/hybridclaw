import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useStickToBottom } from './use-stick-to-bottom';

type ResizeObserverCallback = (entries: ResizeObserverEntry[]) => void;

let resizeObserverCallbacks: ResizeObserverCallback[] = [];

// Capture ResizeObserver instances so tests can drive content-growth events
// manually — jsdom's no-op polyfill from vitest.setup.ts never fires them.
class CapturingResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObserverCallbacks.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    const idx = resizeObserverCallbacks.indexOf(this.callback);
    if (idx >= 0) resizeObserverCallbacks.splice(idx, 1);
  }
}

function fireResize() {
  for (const cb of resizeObserverCallbacks) cb([]);
}

function configureScroller(
  el: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number },
) {
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => metrics.scrollHeight,
  });
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => metrics.clientHeight,
  });
}

// Single mutable handle to the hook's latest return value, populated on every
// render. Lets tests read state and invoke imperatives without manual plumbing.
const hookRef: { current: ReturnType<typeof useStickToBottom> | null } = {
  current: null,
};

function Harness() {
  const stick = useStickToBottom();
  hookRef.current = stick;
  return (
    <div
      ref={stick.scrollRef}
      data-testid="scroller"
      style={{ height: 100, overflow: 'auto' }}
    >
      <div ref={stick.contentRef}>content</div>
    </div>
  );
}

function renderHarness() {
  render(<Harness />);
  const scroller = screen.getByTestId('scroller') as HTMLDivElement;
  // Non-null assertion is safe: Harness sets hookRef during initial render.
  const getHook = () => {
    if (!hookRef.current) throw new Error('hook not initialized');
    return hookRef.current;
  };
  return { scroller, getHook };
}

describe('useStickToBottom', () => {
  let originalRO: typeof ResizeObserver;

  beforeEach(() => {
    resizeObserverCallbacks = [];
    hookRef.current = null;
    originalRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver =
      CapturingResizeObserver as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalRO;
  });

  it('stays pinned and snaps scrollTop to scrollHeight when content grows', () => {
    const { scroller, getHook } = renderHarness();
    configureScroller(scroller, { scrollHeight: 800, clientHeight: 100 });

    expect(getHook().isPinned).toBe(true);

    act(() => {
      fireResize();
    });

    expect(scroller.scrollTop).toBe(800);
    expect(getHook().isPinned).toBe(true);
  });

  it('unpins when the user scrolls beyond the threshold and stays unpinned on growth', () => {
    const { scroller, getHook } = renderHarness();
    configureScroller(scroller, { scrollHeight: 800, clientHeight: 100 });

    act(() => {
      // 800 - 200 - 100 = 500px from bottom — well past PIN_THRESHOLD_PX(120).
      scroller.scrollTop = 200;
      scroller.dispatchEvent(new Event('scroll'));
    });

    expect(getHook().isPinned).toBe(false);

    act(() => {
      configureScroller(scroller, { scrollHeight: 1600, clientHeight: 100 });
      fireResize();
    });

    // scrollTop must NOT have been forced to the bottom while unpinned.
    expect(scroller.scrollTop).toBe(200);
    expect(getHook().isPinned).toBe(false);
  });

  it('re-pins when the user scrolls back near the bottom', () => {
    const { scroller, getHook } = renderHarness();
    configureScroller(scroller, { scrollHeight: 800, clientHeight: 100 });

    act(() => {
      scroller.scrollTop = 200;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(getHook().isPinned).toBe(false);

    act(() => {
      // 800 - 700 - 100 = 0px from bottom — re-pin.
      scroller.scrollTop = 700;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(getHook().isPinned).toBe(true);
  });

  it('resetToBottom snaps scrollTop instantly and re-pins, even when previously unpinned', () => {
    const { scroller, getHook } = renderHarness();
    configureScroller(scroller, { scrollHeight: 800, clientHeight: 100 });

    act(() => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(getHook().isPinned).toBe(false);

    act(() => {
      getHook().resetToBottom();
    });

    expect(scroller.scrollTop).toBe(800);
    expect(getHook().isPinned).toBe(true);
  });

  it('jumpToBottom re-pins immediately and animates scrollTop toward the bottom', async () => {
    const { scroller, getHook } = renderHarness();
    configureScroller(scroller, { scrollHeight: 800, clientHeight: 100 });

    act(() => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(getHook().isPinned).toBe(false);

    act(() => {
      getHook().jumpToBottom();
    });
    // Pin flips back synchronously so the chip hides without waiting for the
    // ease-out to finish.
    expect(getHook().isPinned).toBe(true);

    // Let the rAF easing run; it should land at scrollHeight - clientHeight.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(scroller.scrollTop).toBe(700);
  });
});
