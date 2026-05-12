import { useCallback, useEffect, useRef, useState } from 'react';

// Distance (px) from the bottom at which the view is still considered
// "pinned". A more generous threshold than the old 64px so a single streamed
// token can't silently unpin the user mid-message.
const PIN_THRESHOLD_PX = 120;

interface UseStickToBottomReturn {
  /** Callback ref for the scrollable container. */
  scrollRef: (el: HTMLDivElement | null) => void;
  /** Callback ref for the inner content element whose growth drives auto-scroll. */
  contentRef: (el: HTMLDivElement | null) => void;
  /** True while the viewport is anchored to the latest content. */
  isPinned: boolean;
  /** Smooth-scroll to the bottom and re-pin. */
  jumpToBottom: () => void;
  /**
   * Instant-snap to the bottom and re-pin. Use on session hydrate / switch so
   * a long history doesn't crawl by under a smooth animation.
   */
  resetToBottom: () => void;
}

export function useStickToBottom(): UseStickToBottomReturn {
  const scrollElRef = useRef<HTMLDivElement | null>(null);
  const contentElRef = useRef<HTMLDivElement | null>(null);
  const scrollHandlerRef = useRef<(() => void) | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const [isPinned, setIsPinnedState] = useState(true);
  const pinnedRef = useRef(true);
  // Distinguishes user-initiated scroll events from ones we programmatically
  // caused via scrollTop assignment; without it the auto-scroll's own scroll
  // event would race through the threshold check and flip pin state.
  const programmaticScrollRef = useRef(false);

  const setPinned = useCallback((next: boolean) => {
    if (pinnedRef.current === next) return;
    pinnedRef.current = next;
    setIsPinnedState(next);
  }, []);

  const snapIfPinned = useCallback(() => {
    const scroller = scrollElRef.current;
    if (!scroller || !pinnedRef.current) return;
    if (scroller.scrollHeight <= scroller.clientHeight) return;
    programmaticScrollRef.current = true;
    scroller.scrollTop = scroller.scrollHeight;
  }, []);

  const scrollRef = useCallback(
    (el: HTMLDivElement | null) => {
      const prev = scrollElRef.current;
      if (prev && scrollHandlerRef.current) {
        prev.removeEventListener('scroll', scrollHandlerRef.current);
        scrollHandlerRef.current = null;
      }
      scrollElRef.current = el;
      if (!el) return;
      const onScroll = () => {
        if (programmaticScrollRef.current) {
          programmaticScrollRef.current = false;
          return;
        }
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
        setPinned(distance <= PIN_THRESHOLD_PX);
      };
      scrollHandlerRef.current = onScroll;
      el.addEventListener('scroll', onScroll, { passive: true });
      // The content ref may have attached before us (children mount before
      // parents), in which case its initial ResizeObserver fire was a no-op.
      // Snap now so hydrating into a tall history lands at the bottom.
      snapIfPinned();
    },
    [setPinned, snapIfPinned],
  );

  const contentRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }
      contentElRef.current = el;
      if (!el) return;
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(() => {
        snapIfPinned();
      });
      observer.observe(el);
      resizeObserverRef.current = observer;
    },
    [snapIfPinned],
  );

  useEffect(() => {
    return () => {
      const prev = scrollElRef.current;
      if (prev && scrollHandlerRef.current) {
        prev.removeEventListener('scroll', scrollHandlerRef.current);
      }
      resizeObserverRef.current?.disconnect();
      if (smoothScrollRafRef.current) {
        cancelAnimationFrame(smoothScrollRafRef.current);
      }
    };
  }, []);

  const smoothScrollRafRef = useRef(0);
  const jumpToBottom = useCallback(() => {
    const el = scrollElRef.current;
    if (!el) return;
    if (smoothScrollRafRef.current) {
      cancelAnimationFrame(smoothScrollRafRef.current);
      smoothScrollRafRef.current = 0;
    }
    setPinned(true);
    // Chrome's native scrollTo({behavior:'smooth'}) is a no-op on this
    // container under the current layout (visualViewport-driven height +
    // position:relative chatMain), so hand-roll a 220ms ease-out instead.
    const startTop = el.scrollTop;
    const target = el.scrollHeight - el.clientHeight;
    const delta = target - startTop;
    if (delta <= 0) return;
    const startedAt = performance.now();
    const duration = 220;
    const step = () => {
      const scroller = scrollElRef.current;
      if (!scroller) {
        smoothScrollRafRef.current = 0;
        return;
      }
      const t = Math.min(1, (performance.now() - startedAt) / duration);
      const eased = 1 - (1 - t) ** 3;
      programmaticScrollRef.current = true;
      scroller.scrollTop = startTop + delta * eased;
      if (t < 1) {
        smoothScrollRafRef.current = requestAnimationFrame(step);
      } else {
        smoothScrollRafRef.current = 0;
      }
    };
    smoothScrollRafRef.current = requestAnimationFrame(step);
  }, [setPinned]);

  const resetToBottom = useCallback(() => {
    const el = scrollElRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    setPinned(true);
  }, [setPinned]);

  return { scrollRef, contentRef, isPinned, jumpToBottom, resetToBottom };
}
