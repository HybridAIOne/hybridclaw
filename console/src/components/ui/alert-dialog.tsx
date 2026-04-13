/**
 * AlertDialog — a confirmation dialog built on our own accessibility primitives.
 *
 * Follows the compound-component pattern (à la shadcn / Base UI). Use this instead
 * of Dialog whenever you need to confirm a destructive or irreversible action.
 *
 * Semantic difference from Dialog: renders role="alertdialog" so assistive
 * technologies announce the confirmation prompt immediately.
 *
 * Usage:
 *   <AlertDialog open={open} onOpenChange={setOpen}>
 *     <AlertDialogContent size="sm">
 *       <AlertDialogHeader>
 *         <AlertDialogTitle>Delete item?</AlertDialogTitle>
 *         <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
 *       </AlertDialogHeader>
 *       <AlertDialogFooter>
 *         <AlertDialogCancel>Cancel</AlertDialogCancel>
 *         <AlertDialogAction variant="destructive" onClick={onConfirm}>
 *           Delete
 *         </AlertDialogAction>
 *       </AlertDialogFooter>
 *     </AlertDialogContent>
 *   </AlertDialog>
 */

import {
  type ButtonHTMLAttributes,
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKeydown } from '../../hooks/useEscapeKeydown';
import { useExitAnimation } from '../../hooks/useExitAnimation';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useHideOthers } from '../../hooks/useHideOthers';
import { useScrollLock } from '../../hooks/useScrollLock';
import { cx } from '../../lib/cx';
import styles from './alert-dialog.module.css';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type AlertDialogContextValue = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  titleId: string;
  descriptionId: string;
};

const AlertDialogContext = createContext<AlertDialogContextValue | null>(null);

function useAlertDialogContext() {
  const ctx = useContext(AlertDialogContext);
  if (!ctx)
    throw new Error(
      'AlertDialog components must be used within <AlertDialog>.',
    );
  return ctx;
}

// ---------------------------------------------------------------------------
// AlertDialog (root)
// ---------------------------------------------------------------------------

export function AlertDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <AlertDialogContext.Provider
      value={{
        open: props.open,
        onOpenChange: props.onOpenChange,
        titleId,
        descriptionId,
      }}
    >
      {props.children}
    </AlertDialogContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// AlertDialogContent
// ---------------------------------------------------------------------------

export function AlertDialogContent(props: {
  children: ReactNode;
  className?: string;
  /** Width variant: "sm" (~360px), "default" (~440px), "lg" (~560px). */
  size?: 'sm' | 'default' | 'lg';
  /** Element to focus on open. Defaults to first focusable element. */
  initialFocus?: RefObject<HTMLElement | null>;
}) {
  const ctx = useAlertDialogContext();
  const portalRef = useRef<HTMLDivElement>(null);
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

  const clearExiting = useCallback(() => setExiting(false), []);
  useExitAnimation(panelRef, exiting, clearExiting);

  useScrollLock(open);
  useFocusTrap(panelRef, open, props.initialFocus);
  useEscapeKeydown(() => onOpenChange(false), open);
  useHideOthers(portalRef, open);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' && open) {
      if (!document.getElementById(titleId)) {
        console.warn(
          'AlertDialog: no <AlertDialogTitle> found. Add one for accessible labelling (aria-labelledby).',
        );
      }
    }
  }, [open, titleId]);

  if (typeof document === 'undefined' || (!open && !exiting)) return null;

  const sizeClass =
    props.size === 'sm'
      ? styles.sm
      : props.size === 'lg'
        ? styles.lg
        : undefined;

  return createPortal(
    <div ref={portalRef}>
      <div
        className={cx(styles.backdrop, exiting && styles.exiting)}
        aria-hidden="true"
      />
      <div className={styles.viewport}>
        <div
          ref={panelRef}
          role="alertdialog"
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
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// AlertDialogHeader / AlertDialogTitle / AlertDialogDescription
// ---------------------------------------------------------------------------

export function AlertDialogHeader(props: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx(styles.header, props.className)}>{props.children}</div>
  );
}

export function AlertDialogTitle(props: {
  children: ReactNode;
  className?: string;
}) {
  const { titleId } = useAlertDialogContext();
  return (
    <h3 id={titleId} className={cx(styles.title, props.className)}>
      {props.children}
    </h3>
  );
}

export function AlertDialogDescription(props: {
  children: ReactNode;
  className?: string;
}) {
  const { descriptionId } = useAlertDialogContext();
  return (
    <p id={descriptionId} className={cx(styles.description, props.className)}>
      {props.children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// AlertDialogFooter
// ---------------------------------------------------------------------------

export function AlertDialogFooter(props: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx(styles.footer, props.className)}>{props.children}</div>
  );
}

// ---------------------------------------------------------------------------
// AlertDialogAction
// ---------------------------------------------------------------------------

export function AlertDialogAction(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    children: ReactNode;
    variant?: 'default' | 'destructive';
  },
) {
  const { onOpenChange } = useAlertDialogContext();
  const { children, className, onClick, variant = 'default', ...rest } = props;

  const variantClass =
    variant === 'destructive' ? 'danger-button' : 'primary-button';

  return (
    <button
      {...rest}
      type="button"
      className={className ?? variantClass}
      onClick={(e) => {
        onClick?.(e);
        onOpenChange(false);
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// AlertDialogCancel
// ---------------------------------------------------------------------------

export function AlertDialogCancel(
  props: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode },
) {
  const { onOpenChange } = useAlertDialogContext();
  const { children, className, onClick, ...rest } = props;

  return (
    <button
      {...rest}
      type="button"
      className={className ?? 'ghost-button'}
      onClick={(e) => {
        onClick?.(e);
        onOpenChange(false);
      }}
    >
      {children}
    </button>
  );
}
