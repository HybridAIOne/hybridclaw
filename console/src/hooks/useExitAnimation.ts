import { type RefObject, useEffect } from 'react';

/**
 * Calls `onComplete` after the CSS exit animation finishes on `elementRef`.
 * Listens for both `animationend` and `animationcancel` events, filtering
 * out events from child elements. Falls back to an immediate call when
 * animations are disabled (prefers-reduced-motion, jsdom, etc.).
 *
 * @param onComplete Must be referentially stable (wrap in `useCallback`).
 */
export function useExitAnimation(
  elementRef: RefObject<HTMLElement | null>,
  exiting: boolean,
  onComplete: () => void,
): void {
  useEffect(() => {
    if (!exiting) return;
    const el = elementRef.current;
    if (!el) {
      onComplete();
      return;
    }
    const style = getComputedStyle(el);
    if (
      style.animationName === 'none' ||
      style.animationName === '' ||
      style.animationDuration === '0s'
    ) {
      onComplete();
      return;
    }
    function handleAnimation(event: AnimationEvent) {
      // Ignore events bubbling from children.
      if (event.target !== el) return;
      onComplete();
    }
    el.addEventListener('animationend', handleAnimation);
    el.addEventListener('animationcancel', handleAnimation);
    return () => {
      el.removeEventListener('animationend', handleAnimation);
      el.removeEventListener('animationcancel', handleAnimation);
    };
  }, [exiting, elementRef, onComplete]);
}
