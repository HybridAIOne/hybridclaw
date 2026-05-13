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

  it('stays pinned and snaps scrollTop to maxScrollTop when content grows', () => {
    const { scroller, getHook } = renderHarness();
    configureScroller(scroller, { scrollHeight: 800, clientHeight: 100 });

    expect(getHook().isPinned).toBe(true);

    act(() => {
      fireResize();
    });

    // Clamped to scrollHeight - clientHeight, mirroring the browser's own
    // clamp. Writing scrollHeight directly is a no-op in browsers (stays at
    // maxScrollTop), which would leave the programmatic-scroll flag stuck.
    expect(scroller.scrollTop).toBe(700);
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

    expect(scroller.scrollTop).toBe(700);
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

  it('jumpToBottom retargets each frame when scrollHeight grows mid-animation', async () => {
    // Reproduces the bug fixed in review #1: handleSendMessage appends the
    // user bubble after jumpToBottom is called, so the easing must track the
    // moving bottom rather than the snapshot taken at click time.
    const { scroller, getHook } = renderHarness();
    const metrics = { scrollHeight: 800, clientHeight: 100 };
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => metrics.scrollHeight,
    });
    Object.defineProperty(scroller, 'clientHeight', {
      configurable: true,
      get: () => metrics.clientHeight,
    });

    act(() => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(getHook().isPinned).toBe(false);

    act(() => {
      getHook().jumpToBottom();
    });
    // Grow the content while the rAF easing is in flight.
    await new Promise((resolve) => setTimeout(resolve, 30));
    metrics.scrollHeight = 1200;
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Must land at the *new* bottom, not the 700 that was the bottom at click.
    expect(scroller.scrollTop).toBe(1100);
  });

  it('resetToBottom flips pin even when no scroller is attached so a later attach snaps', () => {
    // Mirrors the session-switch path: the .messageArea unmounts mid-fetch,
    // so resetToBottom must update pinnedRef now and let scrollRef's
    // snap-on-attach do the actual scroll when the new element mounts.
    const { scroller, getHook } = renderHarness();
    configureScroller(scroller, { scrollHeight: 800, clientHeight: 100 });

    // Unpin the user.
    act(() => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(getHook().isPinned).toBe(false);

    // Detach (as React does on conditional unmount), then call resetToBottom.
    act(() => {
      getHook().scrollRef(null);
      getHook().resetToBottom();
    });
    expect(getHook().isPinned).toBe(true);

    // Re-attach: snap-on-attach fires now that pinned is true again.
    act(() => {
      getHook().scrollRef(scroller);
    });
    expect(scroller.scrollTop).toBe(700);
  });

  it('does not leave the programmatic-scroll flag stuck when a write is a no-op', () => {
    // Regression: a no-op scrollTop assignment (target already equals current)
    // doesn't fire a scroll event, so the old code left the flag set and
    // swallowed the next user scroll, blocking unpin.
    const { scroller, getHook } = renderHarness();
    configureScroller(scroller, { scrollHeight: 800, clientHeight: 100 });

    // Park the scroller at the bottom with a clean flag state by dispatching
    // a real scroll event (which the listener consumes).
    act(() => {
      scroller.scrollTop = 700;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(getHook().isPinned).toBe(true);

    act(() => {
      // resetToBottom while already at the bottom: a no-op write. The old
      // code would set the flag without a subsequent scroll event to clear it.
      getHook().resetToBottom();
    });

    // The user now scrolls up past the threshold — must unpin, not be
    // swallowed by a leftover programmatic flag.
    act(() => {
      scroller.scrollTop = 200;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(getHook().isPinned).toBe(false);
  });

  it('scrollRef snaps to bottom when attached after content already overflows', () => {
    // Children mount before parents, so on hydrate contentRef fires its
    // initial ResizeObserver callback while scrollElRef is still null. The
    // safety belt: scrollRef must snap-on-attach if we're still pinned.
    const { scroller, getHook } = renderHarness();
    configureScroller(scroller, { scrollHeight: 800, clientHeight: 100 });
    expect(getHook().isPinned).toBe(true);

    // Re-attach the scroller to the same element — invokes scrollRef again
    // and exercises the snap-on-attach path without needing a remount.
    act(() => {
      getHook().scrollRef(scroller);
    });

    expect(scroller.scrollTop).toBe(700);
  });
});
