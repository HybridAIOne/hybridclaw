import { useEffect } from 'react';

// Reference-counted so concurrent callers (e.g. nested drawers) don't
// clobber each other: the lock is applied when the first caller activates
// and released only when the last one deactivates.
let lockCount = 0;

export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (lockCount++ === 0) {
      // Compensate for the scrollbar disappearing to prevent layout shift.
      const scrollbarWidth =
        window.innerWidth - document.documentElement.clientWidth;
      document.body.style.overflow = 'hidden';
      if (scrollbarWidth > 0) {
        document.body.style.paddingRight = `${scrollbarWidth}px`;
      }
    }
    return () => {
      if (--lockCount === 0) {
        document.body.style.overflow = '';
        document.body.style.paddingRight = '';
      }
    };
  }, [active]);
}
