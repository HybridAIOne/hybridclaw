import { type RefObject, useEffect } from 'react';

const FOCUSABLE_SELECTORS =
  'a[href], button:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), textarea:not([disabled]), ' +
  '[tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS),
  );
}

/**
 * Traps keyboard focus inside `containerRef` while `active` is true.
 *
 * On activation: moves focus to the first focusable element inside the
 * container (deferred one frame so CSS enter-transitions don't interfere).
 *
 * While active: Tab / Shift+Tab cycle within the container. Pair with
 * `FocusGuard` sentinels rendered before and after the content to catch
 * focus that reaches the boundary via keyboard navigation.
 *
 * On deactivation: restores focus to whichever element was focused when the
 * trap was activated.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  initialFocusRef?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Defer initial focus one frame so the element is visible after any
    // CSS transition that runs synchronously with the state change.
    const raf = requestAnimationFrame(() => {
      const target = initialFocusRef?.current ?? getFocusable(container)[0];
      target?.focus({ preventScroll: true });
    });

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab' || !container) return;
      const items = getFocusable(container);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const focused = document.activeElement;

      if (e.shiftKey) {
        if (focused === first || !container.contains(focused)) {
          e.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else {
        if (focused === last || !container.contains(focused)) {
          e.preventDefault();
          first.focus({ preventScroll: true });
        }
      }
    }

    document.addEventListener('keydown', onKeyDown);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, [active, containerRef, initialFocusRef]);
}

// FocusGuard sentinel component lives in FocusGuard.tsx (needs JSX).
export { FocusGuard } from './FocusGuard';
