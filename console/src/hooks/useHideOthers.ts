import { type RefObject, useEffect } from 'react';

/**
 * While `active`, sets `aria-hidden="true"` on every direct child of
 * `document.body` that is not — and does not contain — the element referenced
 * by `containerRef`. This prevents assistive technology from interacting with
 * background content while a modal / drawer is open.
 *
 * Restores each element's previous `aria-hidden` value (or removes the
 * attribute entirely if it wasn't present) on cleanup.
 */
export function useHideOthers(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previous = new Map<Element, string | null>();

    for (const child of document.body.children) {
      if (child === container || child.contains(container)) continue;
      previous.set(child, child.getAttribute('aria-hidden'));
      child.setAttribute('aria-hidden', 'true');
    }

    return () => {
      for (const [el, prev] of previous) {
        if (prev === null) {
          el.removeAttribute('aria-hidden');
        } else {
          el.setAttribute('aria-hidden', prev);
        }
      }
    };
  }, [active, containerRef]);
}
