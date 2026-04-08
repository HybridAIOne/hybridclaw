/**
 * Sheet — a slide-in panel (drawer) built on our own accessibility primitives.
 *
 * Mirrors the shadcn Sheet API:
 *   <Sheet open={open} onOpenChange={setOpen}>
 *     <SheetContent side="left">
 *       <SheetHeader className="sr-only">
 *         <SheetTitle>Panel title</SheetTitle>
 *         <SheetDescription>What this panel does.</SheetDescription>
 *       </SheetHeader>
 *       …your content…
 *     </SheetContent>
 *   </Sheet>
 */

import {
  createContext,
  type HTMLAttributes,
  type ReactNode,
  useContext,
  useId,
  useRef,
} from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKeydown } from '../../hooks/useEscapeKeydown';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useHideOthers } from '../../hooks/useHideOthers';
import { useScrollLock } from '../../hooks/useScrollLock';
import { cx } from '../../lib/cx';
import styles from './index.module.css';

// ---------------------------------------------------------------------------
// Internal context
// ---------------------------------------------------------------------------

type SheetContextValue = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  titleId: string;
  descriptionId: string;
};

const SheetContext = createContext<SheetContextValue | null>(null);

function useSheetContext() {
  const ctx = useContext(SheetContext);
  if (!ctx) throw new Error('Sheet components must be used within <Sheet>.');
  return ctx;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SheetSide = 'left' | 'right' | 'top' | 'bottom';

// ---------------------------------------------------------------------------
// Sheet (root)
// ---------------------------------------------------------------------------

/**
 * Controlled root — pass `open` + `onOpenChange` (same contract as a
 * controlled `<select>`).
 */
export function Sheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <SheetContext.Provider
      value={{
        open: props.open,
        onOpenChange: props.onOpenChange,
        titleId,
        descriptionId,
      }}
    >
      {props.children}
    </SheetContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// SheetContent
// ---------------------------------------------------------------------------

type SheetContentProps = HTMLAttributes<HTMLElement> & {
  /** Which edge the panel slides in from. Defaults to "right". */
  side?: SheetSide;
  children: ReactNode;
};

/**
 * The slide-in panel itself. Portals to `document.body`, renders a backdrop
 * and the content panel, and wires up all accessibility behaviour (focus
 * trap, Escape, aria-hidden on background, scroll lock).
 *
 * Forwards all HTML attributes (including `data-*` and `aria-*`) onto the
 * panel element, so callers can pass `aria-label`, `data-sidebar`, etc.
 */
export function SheetContent({
  side = 'right',
  children,
  className,
  ...rest
}: SheetContentProps) {
  const ctx = useSheetContext();
  const panelRef = useRef<HTMLElement>(null);
  const { open, onOpenChange, titleId, descriptionId } = ctx;

  useScrollLock(open);
  useFocusTrap(panelRef, open);
  useEscapeKeydown(() => onOpenChange(false), open);
  useHideOthers(panelRef, open);

  const sideClass = {
    left: styles.left,
    right: styles.right,
    top: styles.top,
    bottom: styles.bottom,
  }[side];

  return createPortal(
    <>
      {/* Overlay — click to dismiss; permanently aria-hidden because Escape
          is the keyboard-accessible dismiss path. */}
      <div
        data-sheet="overlay"
        className={cx(styles.overlay, open && styles.overlayVisible)}
        aria-hidden="true"
        onClick={() => onOpenChange(false)}
      />

      {/* Panel */}
      <section
        {...rest}
        ref={panelRef}
        data-sheet="content"
        data-side={side}
        data-state={open ? 'open' : 'closed'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className={cx(
          styles.content,
          sideClass,
          open && styles.contentOpen,
          className,
        )}
      >
        {children}
      </section>
    </>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// SheetHeader / SheetTitle / SheetDescription
// ---------------------------------------------------------------------------

/**
 * Wraps the accessible title and description. Always rendered visually
 * hidden — its only purpose is to provide an accessible name and
 * description for the dialog.
 */
export function SheetHeader({ children }: { children: ReactNode }) {
  return <div className={styles.srOnly}>{children}</div>;
}

/**
 * Provides the accessible name for the dialog.
 * Rendered inside SheetHeader; automatically linked via `aria-labelledby`.
 */
export function SheetTitle({ children }: { children: ReactNode }) {
  const { titleId } = useSheetContext();
  return <h2 id={titleId}>{children}</h2>;
}

/**
 * Provides the accessible description for the dialog.
 * Rendered inside SheetHeader; automatically linked via `aria-describedby`.
 */
export function SheetDescription({ children }: { children: ReactNode }) {
  const { descriptionId } = useSheetContext();
  return <p id={descriptionId}>{children}</p>;
}

// ---------------------------------------------------------------------------
// sr-only helper class (exposed for callers who want to suppress SheetHeader)
// ---------------------------------------------------------------------------

/** CSS class that visually hides an element while keeping it in the a11y tree. */
export const sheetSrOnly = styles.srOnly;
