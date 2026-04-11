/**
 * Dialog — a modal dialog built on our own accessibility primitives.
 *
 * Follows the Base UI compound-component pattern: compose sub-components
 * to build the dialog layout you need.
 *
 * Usage:
 *   <Dialog open={open} onOpenChange={setOpen}>
 *     <DialogContent>
 *       <DialogHeader>
 *         <DialogTitle>Confirm deletion</DialogTitle>
 *         <DialogDescription>This cannot be undone.</DialogDescription>
 *       </DialogHeader>
 *       <DialogFooter>
 *         <DialogClose className="ghost-button">Cancel</DialogClose>
 *         <button className="danger-button" onClick={onConfirm}>Delete</button>
 *       </DialogFooter>
 *     </DialogContent>
 *   </Dialog>
 *
 * For dialogs triggered by a button, use DialogTrigger:
 *   <Dialog open={open} onOpenChange={setOpen}>
 *     <DialogTrigger className="primary-button">Open</DialogTrigger>
 *     <DialogContent>…</DialogContent>
 *   </Dialog>
 */

import {
  type ButtonHTMLAttributes,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKeydown } from '../../hooks/useEscapeKeydown';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useHideOthers } from '../../hooks/useHideOthers';
import { useScrollLock } from '../../hooks/useScrollLock';
import { cx } from '../../lib/cx';
import styles from './index.module.css';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type DialogContextValue = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  titleId: string;
  descriptionId: string;
};

const DialogContext = createContext<DialogContextValue | null>(null);

function useDialogContext() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('Dialog components must be used within <Dialog>.');
  return ctx;
}

// ---------------------------------------------------------------------------
// Dialog (root)
// ---------------------------------------------------------------------------

export function Dialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <DialogContext.Provider
      value={{
        open: props.open,
        onOpenChange: props.onOpenChange,
        titleId,
        descriptionId,
      }}
    >
      {props.children}
    </DialogContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// DialogTrigger
// ---------------------------------------------------------------------------

export function DialogTrigger(
  props: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode },
) {
  const { onOpenChange } = useDialogContext();
  const { children, className, onClick, ...rest } = props;

  return (
    <button
      {...rest}
      type="button"
      className={className}
      onClick={(e) => {
        onClick?.(e);
        onOpenChange(true);
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// DialogContent
// ---------------------------------------------------------------------------

export function DialogContent(props: {
  children: ReactNode;
  className?: string;
  /** Width variant. Defaults to "default" (~440px). */
  size?: 'sm' | 'default' | 'lg';
}) {
  const ctx = useDialogContext();
  const panelRef = useRef<HTMLDivElement>(null);
  const { open, onOpenChange, titleId, descriptionId } = ctx;
  const [exiting, setExiting] = useState(false);
  const prevOpenRef = useRef(open);

  useEffect(() => {
    if (prevOpenRef.current && !open) {
      setExiting(true);
    }
    prevOpenRef.current = open;
  }, [open]);

  // Remove from DOM after exit animation completes.
  useEffect(() => {
    if (!exiting) return;
    const el = panelRef.current;
    if (!el) {
      setExiting(false);
      return;
    }
    const style = getComputedStyle(el);
    if (
      style.animationName === 'none' ||
      style.animationName === '' ||
      style.animationDuration === '0s'
    ) {
      setExiting(false);
      return;
    }
    function handleAnimationEnd() {
      setExiting(false);
    }
    el.addEventListener('animationend', handleAnimationEnd, { once: true });
    return () => el.removeEventListener('animationend', handleAnimationEnd);
  }, [exiting]);

  useScrollLock(open);
  useFocusTrap(panelRef, open);
  useEscapeKeydown(() => onOpenChange(false), open);
  useHideOthers(panelRef, open);

  if (typeof document === 'undefined' || (!open && !exiting)) return null;

  const sizeClass =
    props.size === 'sm'
      ? styles.sm
      : props.size === 'lg'
        ? styles.lg
        : undefined;

  return createPortal(
    <>
      <div
        className={cx(styles.backdrop, exiting && styles.exiting)}
        aria-hidden="true"
        onClick={() => !exiting && onOpenChange(false)}
      />
      <div className={styles.viewport}>
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          data-state={exiting ? 'closed' : 'open'}
          className={cx(
            styles.content,
            sizeClass,
            exiting && styles.exiting,
            props.className,
          )}
        >
          {props.children}
        </div>
      </div>
    </>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// DialogHeader / DialogTitle / DialogDescription
// ---------------------------------------------------------------------------

export function DialogHeader(props: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx(styles.header, props.className)}>{props.children}</div>
  );
}

export function DialogTitle(props: {
  children: ReactNode;
  className?: string;
}) {
  const { titleId } = useDialogContext();
  return (
    <h3 id={titleId} className={cx(styles.title, props.className)}>
      {props.children}
    </h3>
  );
}

export function DialogDescription(props: {
  children: ReactNode;
  className?: string;
}) {
  const { descriptionId } = useDialogContext();
  return (
    <p id={descriptionId} className={cx(styles.description, props.className)}>
      {props.children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// DialogFooter
// ---------------------------------------------------------------------------

export function DialogFooter(props: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx(styles.footer, props.className)}>{props.children}</div>
  );
}

// ---------------------------------------------------------------------------
// DialogClose
// ---------------------------------------------------------------------------

export function DialogClose(
  props: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode },
) {
  const { onOpenChange } = useDialogContext();
  const { children, className, onClick, ...rest } = props;

  return (
    <button
      {...rest}
      type="button"
      className={className}
      onClick={(e) => {
        onClick?.(e);
        onOpenChange(false);
      }}
    >
      {children}
    </button>
  );
}
