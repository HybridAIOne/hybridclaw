import { type RefObject, useEffect } from 'react';

/**
 * Module-level reference count per element.  When count > 0 the element is
 * inert; when it drops back to 0, inert is removed.  This lets concurrent
 * modals (Dialog + Sheet, nested dialogs, etc.) compose correctly — each
 * caller is independent and the last one to deactivate restores the element.
 */
const inertCount = new WeakMap<Element, number>();

function markInert(el: Element): void {
  const count = (inertCount.get(el) ?? 0) + 1;
  inertCount.set(el, count);
  if (count === 1) {
    (el as HTMLElement).inert = true;
  }
}

function unmarkInert(el: Element): void {
  const count = (inertCount.get(el) ?? 1) - 1;
  if (count <= 0) {
    inertCount.delete(el);
    (el as HTMLElement).inert = false;
  } else {
    inertCount.set(el, count);
  }
}

/**
 * While `active`, marks every direct child of `document.body` — except the
 * one containing `containerRef` — as `inert`.  Reference-counted so
 * concurrent/nested modals compose correctly.
 */
export function useHideOthers(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const marked: Element[] = [];

    for (const child of document.body.children) {
      if (child === container || child.contains(container)) continue;
      markInert(child);
      marked.push(child);
    }

    return () => {
      for (const el of marked) {
        unmarkInert(el);
      }
    };
  }, [active, containerRef]);
}
