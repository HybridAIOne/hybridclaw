import { type RefObject, useEffect } from 'react';

/**
 * Calls `onComplete` after the CSS exit animation or transition finishes on
 * `elementRef`. Listens for `animationend`, `animationcancel`, `transitionend`,
 * and `transitioncancel` events, filtering out events from child elements.
 * Falls back to an immediate call when animations/transitions are disabled
 * (prefers-reduced-motion, jsdom, etc.).
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
    const hasAnimation =
      style.animationName !== 'none' &&
      style.animationName !== '' &&
      style.animationDuration !== '0s';
    const hasTransition =
      style.transitionProperty !== 'none' &&
      style.transitionProperty !== '' &&
      style.transitionDuration !== '0s';
    if (!hasAnimation && !hasTransition) {
      onComplete();
      return;
    }
    let fired = false;
    function handleEnd(event: Event) {
      if (event.target !== el || fired) return;
      fired = true;
      onComplete();
    }
    el.addEventListener('animationend', handleEnd);
    el.addEventListener('animationcancel', handleEnd);
    el.addEventListener('transitionend', handleEnd);
    el.addEventListener('transitioncancel', handleEnd);
    return () => {
      el.removeEventListener('animationend', handleEnd);
      el.removeEventListener('animationcancel', handleEnd);
      el.removeEventListener('transitionend', handleEnd);
      el.removeEventListener('transitioncancel', handleEnd);
    };
  }, [exiting, elementRef, onComplete]);
}
