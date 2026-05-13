import { useCallback, useEffect, useRef, useState } from 'react';

// Distance (px) from the bottom at which the view is still considered
// "pinned". A more generous threshold than the old 64px so a single streamed
// token can't silently unpin the user mid-message.
const PIN_THRESHOLD_PX = 120;
// Hand-rolled ease-out duration for jumpToBottom — see jumpToBottom comment.
const JUMP_DURATION_MS = 220;

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
  // AbortController owns the scroll listener for the currently-attached element;
  // aborting it both removes the listener and signals the previous attachment is
  // gone. Lets us avoid a separate ref for the handler function.
  const scrollListenerAbortRef = useRef<AbortController | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const smoothScrollRafRef = useRef(0);

  const [isPinned, setIsPinnedState] = useState(true);
  const pinnedRef = useRef(true);
  // Distinguishes user-initiated scroll events from ones we programmatically
  // caused via scrollTop assignment; without it the auto-scroll's own scroll
  // event would race through the threshold check and flip pin state. Each
  // programmatic write consumes exactly one subsequent scroll event.
  const programmaticScrollRef = useRef(false);

  const setPinned = useCallback((next: boolean) => {
    if (pinnedRef.current === next) return;
    pinnedRef.current = next;
    setIsPinnedState(next);
  }, []);

  // Performs a programmatic scrollTop write, but only sets the
  // `programmaticScrollRef` flag when the assignment will actually move the
  // scroller. A no-op assignment (already at the clamped target) doesn't fire
  // a `scroll` event in most browsers, which would leave the flag stuck `true`
  // and cause the next user scroll to be swallowed.
  const programmaticScrollTo = useCallback(
    (scroller: HTMLDivElement, target: number) => {
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const clamped = Math.max(0, Math.min(target, maxTop));
      if (clamped === scroller.scrollTop) return;
      programmaticScrollRef.current = true;
      scroller.scrollTop = clamped;
    },
    [],
  );

  const snapIfPinned = useCallback(() => {
    const scroller = scrollElRef.current;
    if (!scroller || !pinnedRef.current) return;
    if (scroller.scrollHeight <= scroller.clientHeight) return;
    programmaticScrollTo(scroller, scroller.scrollHeight);
  }, [programmaticScrollTo]);

  const scrollRef = useCallback(
    (el: HTMLDivElement | null) => {
      scrollListenerAbortRef.current?.abort();
      scrollListenerAbortRef.current = null;
      scrollElRef.current = el;
      if (!el) return;
      const controller = new AbortController();
      scrollListenerAbortRef.current = controller;
      el.addEventListener(
        'scroll',
        () => {
          if (programmaticScrollRef.current) {
            programmaticScrollRef.current = false;
            return;
          }
          const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
          setPinned(distance <= PIN_THRESHOLD_PX);
        },
        { passive: true, signal: controller.signal },
      );
      // The content ref may have attached before us (children mount before
      // parents), in which case its initial ResizeObserver fire was a no-op.
      // Snap now so hydrating into a tall history lands at the bottom.
      snapIfPinned();
    },
    [setPinned, snapIfPinned],
  );

  const contentRef = useCallback(
    (el: HTMLDivElement | null) => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      if (!el || typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(() => snapIfPinned());
      observer.observe(el);
      resizeObserverRef.current = observer;
    },
    [snapIfPinned],
  );

  const jumpToBottom = useCallback(() => {
    const el = scrollElRef.current;
    if (!el) return;
    if (smoothScrollRafRef.current) {
      cancelAnimationFrame(smoothScrollRafRef.current);
      smoothScrollRafRef.current = 0;
    }
    setPinned(true);
    // Honor prefers-reduced-motion: this is a JS-driven animation and isn't
    // covered by CSS @media rules, so check explicitly and fall back to an
    // instant snap.
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      programmaticScrollTo(el, el.scrollHeight);
      return;
    }
    // Chrome's native scrollTo({behavior:'smooth'}) is a no-op on this
    // container under the current layout (visualViewport-driven height +
    // position:relative chatMain), so hand-roll an ease-out instead.
    const startTop = el.scrollTop;
    if (el.scrollHeight - el.clientHeight - startTop <= 0) return;
    // performance.now() inside the step (not the rAF `now` arg) is what makes
    // the jsdom test deterministic — keep it. programmaticScrollTo skips the
    // flag when the write is a no-op so the listener never gets stuck; one
    // consequence is that a user wheel inside the 220ms window can land on a
    // frame where a real (non-no-op) write set the flag and be swallowed —
    // they'd need to scroll again to unpin. Acceptable for a 220ms easing.
    const startedAt = performance.now();
    const step = () => {
      const scroller = scrollElRef.current;
      if (!scroller) {
        smoothScrollRafRef.current = 0;
        return;
      }
      const t = Math.min(1, (performance.now() - startedAt) / JUMP_DURATION_MS);
      const eased = 1 - (1 - t) ** 3;
      // Recompute target each frame: stream tokens or an optimistic user
      // bubble appended after jumpToBottom() was called would otherwise leave
      // us short of the real bottom for the duration of the ease-out.
      const target = scroller.scrollHeight - scroller.clientHeight;
      programmaticScrollTo(scroller, startTop + (target - startTop) * eased);
      smoothScrollRafRef.current = t < 1 ? requestAnimationFrame(step) : 0;
    };
    smoothScrollRafRef.current = requestAnimationFrame(step);
  }, [setPinned, programmaticScrollTo]);

  const resetToBottom = useCallback(() => {
    // Pin must flip even when the scroller is currently unmounted — e.g. on
    // session switch the .messageArea remounts mid-fetch, so the actual scroll
    // happens later via scrollRef's snap-on-attach. Without this flip the new
    // session would inherit the previous session's unpinned state.
    setPinned(true);
    const el = scrollElRef.current;
    if (!el) return;
    programmaticScrollTo(el, el.scrollHeight);
  }, [setPinned, programmaticScrollTo]);

  useEffect(() => {
    return () => {
      scrollListenerAbortRef.current?.abort();
      resizeObserverRef.current?.disconnect();
      if (smoothScrollRafRef.current) {
        cancelAnimationFrame(smoothScrollRafRef.current);
      }
    };
  }, []);

  return { scrollRef, contentRef, isPinned, jumpToBottom, resetToBottom };
}
