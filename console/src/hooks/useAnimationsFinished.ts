import { type RefObject, useEffect } from 'react';

/**
 * Calls `onComplete` when all CSS animations/transitions on `ref` finish.
 * Uses the Web Animations API (el.getAnimations()) — handles multiple
 * concurrent animations naturally. Falls back to immediate call when
 * there are no running animations (jsdom, prefers-reduced-motion, etc.).
 *
 * @param onComplete Must be referentially stable (wrap in `useCallback`).
 */
export function useAnimationsFinished(
  ref: RefObject<HTMLElement | null>,
  exiting: boolean,
  onComplete: () => void,
): void {
  useEffect(() => {
    if (!exiting) return;
    const el = ref.current;
    if (!el) {
      onComplete();
      return;
    }
    const animations = el.getAnimations();
    if (animations.length === 0) {
      onComplete();
      return;
    }
    let cancelled = false;
    Promise.all(animations.map((a) => a.finished)).then(
      () => {
        if (!cancelled) onComplete();
      },
      () => {
        if (!cancelled) onComplete();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [exiting, ref, onComplete]);
}
