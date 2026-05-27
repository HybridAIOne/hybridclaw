/**
 * Invisible sentinel rendered at the boundary of a focus-trapped container.
 * When the browser would move focus past the boundary (Tab past the last
 * focusable element, or Shift+Tab before the first), the sentinel receives
 * focus and fires `onFocus`, which redirects focus back into the container.
 *
 * Usage (inside DialogContent):
 *   <FocusGuard onFocus={focusLast} />
 *     ...content...
 *   <FocusGuard onFocus={focusFirst} />
 */
export function FocusGuard({ onFocus }: { onFocus: () => void }) {
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: sentinel is intentionally focusable-but-hidden; it catches Tab/Shift+Tab at the boundary and immediately redirects focus
    <span
      // biome-ignore lint/a11y/noNoninteractiveTabindex: sentinel needs tabIndex so the browser's tab order reaches it at the container boundary
      tabIndex={0}
      aria-hidden="true"
      style={{
        position: 'fixed',
        outline: 'none',
        opacity: 0,
        pointerEvents: 'none',
      }}
      onFocus={onFocus}
    />
  );
}
