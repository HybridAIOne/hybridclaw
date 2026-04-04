import { useEffect } from 'react';

/**
 * Fires `onEscape` when the Escape key is pressed, unless focus is inside an
 * editable element (input, textarea, contenteditable) where Escape has its
 * own meaning.
 */
export function useEscapeKeydown(onEscape: () => void, active: boolean): void {
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
      onEscape();
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [active, onEscape]);
}
