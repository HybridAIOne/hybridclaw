import { act, render } from '@testing-library/react';
import { useCallback, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useStickToBottom } from './use-stick-to-bottom';

type Callback = (entries: ResizeObserverEntry[]) => void;

interface FakeObserver {
  callback: Callback;
  targets: Element[];
}

let fakeObservers: FakeObserver[] = [];

// Capture ResizeObserver instances so tests can drive content-growth events
// manually — jsdom's no-op polyfill from vitest.setup.ts never fires them.
class CapturingResizeObserver {
  private targets: Element[] = [];
  private record: FakeObserver;

  constructor(callback: Callback) {
    this.record = { callback, targets: this.targets };
    fakeObservers.push(this.record);
  }

  observe(target: Element) {
    this.targets.push(target);
  }

  unobserve(target: Element) {
    const idx = this.targets.indexOf(target);
    if (idx >= 0) this.targets.splice(idx, 1);
  }

  disconnect() {
    this.targets.length = 0;
    const idx = fakeObservers.indexOf(this.record);
    if (idx >= 0) fakeObservers.splice(idx, 1);
  }
}

function fireResize() {
  for (const observer of fakeObservers) {
    observer.callback([]);
  }
}

interface ScrollMetrics {
  scrollHeight: number;
  clientHeight: number;
}

function configureScroller(el: HTMLElement, metrics: ScrollMetrics) {
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => metrics.scrollHeight,
  });
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => metrics.clientHeight,
  });
}

interface HarnessResult {
  isPinned: boolean;
  jumpToBottom: () => void;
  resetToBottom: () => void;
  scrollEl: HTMLDivElement | null;
}

function renderHarness(): HarnessResult {
  const result: HarnessResult = {
    isPinned: true,
    jumpToBottom: () => {},
    resetToBottom: () => {},
    scrollEl: null,
  };

  function Harness() {
    const stick = useStickToBottom();
    result.isPinned = stick.isPinned;
    result.jumpToBottom = stick.jumpToBottom;
    result.resetToBottom = stick.resetToBottom;
    const localScrollRef = useRef<HTMLDivElement | null>(null);
    const setScrollRef = useCallback(
      (el: HTMLDivElement | null) => {
        localScrollRef.current = el;
        result.scrollEl = el;
        stick.scrollRef(el);
      },
      [stick.scrollRef],
    );
    return (
      <div
        ref={setScrollRef}
        data-testid="scroller"
        style={{ height: 100, overflow: 'auto' }}
      >
        <div ref={stick.contentRef} data-testid="content">
          content
        </div>
      </div>
    );
  }

  render(<Harness />);
  return result;
}

describe('useStickToBottom', () => {
  let originalRO: typeof ResizeObserver;

  beforeEach(() => {
    fakeObservers = [];
    originalRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver =
      CapturingResizeObserver as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalRO;
  });

  it('stays pinned and snaps scrollTop to scrollHeight when content grows', () => {
    const harness = renderHarness();
    const scroller = harness.scrollEl;
    if (!scroller) throw new Error('scroll element not attached');
    configureScroller(scroller, { scrollHeight: 800, clientHeight: 100 });

    expect(harness.isPinned).toBe(true);

    act(() => {
      fireResize();
    });

    expect(scroller.scrollTop).toBe(800);
    expect(harness.isPinned).toBe(true);
  });

  it('unpins when the user scrolls beyond the threshold and stays unpinned on growth', () => {
    const harness = renderHarness();
    const scroller = harness.scrollEl;
    if (!scroller) throw new Error('scroll element not attached');
    configureScroller(scroller, { scrollHeight: 800, clientHeight: 100 });

    act(() => {
      // 800 - 200 - 100 = 500px from bottom — well past PIN_THRESHOLD_PX(120).
      scroller.scrollTop = 200;
      scroller.dispatchEvent(new Event('scroll'));
    });

    expect(harness.isPinned).toBe(false);

    act(() => {
      configureScroller(scroller, { scrollHeight: 1600, clientHeight: 100 });
      fireResize();
    });

    // scrollTop must NOT have been forced to the bottom while unpinned.
    expect(scroller.scrollTop).toBe(200);
    expect(harness.isPinned).toBe(false);
  });

  it('re-pins when the user scrolls back near the bottom', () => {
    const harness = renderHarness();
    const scroller = harness.scrollEl;
    if (!scroller) throw new Error('scroll element not attached');
    configureScroller(scroller, { scrollHeight: 800, clientHeight: 100 });

    act(() => {
      scroller.scrollTop = 200;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(harness.isPinned).toBe(false);

    act(() => {
      // 800 - 700 - 100 = 0px from bottom — re-pin.
      scroller.scrollTop = 700;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(harness.isPinned).toBe(true);
  });

  it('resetToBottom snaps scrollTop instantly and re-pins, even when previously unpinned', () => {
    const harness = renderHarness();
    const scroller = harness.scrollEl;
    if (!scroller) throw new Error('scroll element not attached');
    configureScroller(scroller, { scrollHeight: 800, clientHeight: 100 });

    act(() => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(harness.isPinned).toBe(false);

    act(() => {
      harness.resetToBottom();
    });

    expect(scroller.scrollTop).toBe(800);
    expect(harness.isPinned).toBe(true);
  });

  it('jumpToBottom re-pins immediately and animates scrollTop toward the bottom', async () => {
    const harness = renderHarness();
    const scroller = harness.scrollEl;
    if (!scroller) throw new Error('scroll element not attached');
    configureScroller(scroller, { scrollHeight: 800, clientHeight: 100 });

    act(() => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(harness.isPinned).toBe(false);

    act(() => {
      harness.jumpToBottom();
    });
    // Pin flips back synchronously so the chip hides without waiting for the
    // ease-out to finish.
    expect(harness.isPinned).toBe(true);

    // Let the rAF easing run; it should land at scrollHeight - clientHeight.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(scroller.scrollTop).toBe(700);
  });
});
