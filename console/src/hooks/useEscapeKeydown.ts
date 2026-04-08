import { useEffect, useRef } from 'react';

/**
 * Fires `onEscape` when the Escape key is pressed, unless focus is inside an
 * editable element (input, textarea, contenteditable) where Escape has its
 * own meaning.
 */
export function useEscapeKeydown(onEscape: () => void, active: boolean): void {
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  });

  useEffect(() => {
    if (!active) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
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
