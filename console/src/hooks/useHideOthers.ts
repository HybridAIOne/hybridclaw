import { type RefObject, useEffect } from 'react';

/**
 * While `active`, sets the `inert` attribute on every direct child of
 * `document.body` that is not — and does not contain — the element referenced
 * by `containerRef`. `inert` both hides elements from assistive technology
 * and makes them non-focusable / non-clickable, providing stronger modal
 * isolation than `aria-hidden` alone.
 *
 * Restores each element's previous state on cleanup.
 */
export function useHideOthers(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previous = new Map<Element, boolean>();

    for (const child of document.body.children) {
      if (child === container || child.contains(container)) continue;
      previous.set(child, (child as HTMLElement).inert ?? false);
      (child as HTMLElement).inert = true;
    }

    return () => {
      for (const [el, wasInert] of previous) {
        (el as HTMLElement).inert = wasInert;
      }
    };
  }, [active, containerRef]);
}
