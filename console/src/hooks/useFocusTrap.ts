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

    // If focus escapes the container via a pointer click or programmatic
    // call, pull it back on the next frame.
    function onFocusOut() {
      requestAnimationFrame(() => {
        // Container may have been removed from DOM between focusout and rAF callback
        if (
          container?.isConnected &&
          !container.contains(document.activeElement)
        ) {
          getFocusable(container)[0]?.focus({ preventScroll: true });
        }
      });
    }

    document.addEventListener('keydown', onKeyDown);
    container.addEventListener('focusout', onFocusOut);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown);
      container.removeEventListener('focusout', onFocusOut);
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, [active, containerRef, initialFocusRef]);
}
