import { useEffect } from 'react';

/**
 * Locks document body scroll when active. Restores the previous overflow
 * value on cleanup so nested/concurrent callers don't clobber each other.
 */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [active]);
}
