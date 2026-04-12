import { useEffect, useRef } from 'react';

/**
 * Fires `onEscape` when the Escape key is pressed, skipping form-like elements
 * (input, textarea, select, contenteditable) to avoid conflicts with their own
 * keyboard interactions.
 */
export function useEscapeKeydown(onEscape: () => void, active: boolean): void {
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!active) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      ) {
        return;
      }
      e.stopPropagation();
      onEscapeRef.current();
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [active]);
}
