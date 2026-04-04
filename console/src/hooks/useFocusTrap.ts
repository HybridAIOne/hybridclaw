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
 * While active: Tab / Shift+Tab cycle within the container; focus that
 * escapes via any other means (pointer, programmatic) is pulled back.
 *
 * On deactivation: restores focus to whichever element was focused when the
 * trap was activated.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    // Narrow to non-null for use inside closures.
    if (!container) return;
    const el: HTMLElement = container;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Defer initial focus one frame so the element is visible after any
    // CSS transition that runs synchronously with the state change.
    const raf = requestAnimationFrame(() => {
      getFocusable(el)[0]?.focus({ preventScroll: true });
    });

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      const items = getFocusable(el);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const focused = document.activeElement;

      if (e.shiftKey) {
        if (focused === first || !el.contains(focused)) {
          e.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else {
        if (focused === last || !el.contains(focused)) {
          e.preventDefault();
          first.focus({ preventScroll: true });
        }
      }
    }

    // If focus escapes the container via a pointer click or programmatic
    // call, pull it back on the next frame.
    function onFocusOut() {
      requestAnimationFrame(() => {
        if (el.isConnected && !el.contains(document.activeElement)) {
          getFocusable(el)[0]?.focus({ preventScroll: true });
        }
      });
    }

    document.addEventListener('keydown', onKeyDown);
    el.addEventListener('focusout', onFocusOut);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown);
      el.removeEventListener('focusout', onFocusOut);
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, [active, containerRef]);
}
