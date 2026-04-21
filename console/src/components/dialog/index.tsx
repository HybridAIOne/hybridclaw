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
import styles from './index.module.css';

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

export function DialogContent(props: {
  children: ReactNode;
  className?: string;
  /** Width variant: "sm" (~360px), "default" (~440px), "lg" (~560px). */
  size?: 'sm' | 'default' | 'lg';
  /** Element to focus on open. Defaults to first focusable element. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** When true, clicking the backdrop does not close the dialog. */
  preventCloseOnOutsideClick?: boolean;
  /** ARIA role. Use "alertdialog" for confirmation prompts. Defaults to "dialog". */
  role?: 'dialog' | 'alertdialog';
}) {
  const ctx = useDialogContext();
  const portalRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { open, onOpenChange, titleId, descriptionId } = ctx;
  const [exiting, setExiting] = useState(false);
  const prevOpenRef = useRef(open);

  // Track open->closed transitions to keep the panel mounted during the CSS
  // exit animation. Once the animation completes, useExitAnimation calls
  // clearExiting and the portal unmounts.
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
          'Dialog: no <DialogTitle> found. Add one for accessible labelling (aria-labelledby).',
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
        onClick={() =>
          !exiting && !props.preventCloseOnOutsideClick && onOpenChange(false)
        }
      />
      <div className={styles.viewport}>
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is always dialog or alertdialog, both support aria-modal */}
        <div
          ref={panelRef}
          role={props.role ?? 'dialog'}
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

export function DialogFooter(props: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx(styles.footer, props.className)}>{props.children}</div>
  );
}

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
