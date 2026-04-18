import {
  type ButtonHTMLAttributes,
  createContext,
  type HTMLAttributes,
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
import { useAnimationsFinished } from '../../hooks/useAnimationsFinished';
import { useEscapeKeydown } from '../../hooks/useEscapeKeydown';
import {
  FOCUSABLE_SELECTORS,
  FocusGuard,
  useFocusTrap,
} from '../../hooks/useFocusTrap';
import { useHideOthers } from '../../hooks/useHideOthers';
import { useScrollLock } from '../../hooks/useScrollLock';
import { cx } from '../../lib/cx';
import styles from './index.module.css';

type DialogContextValue = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  titleId: string;
  descriptionId: string;
  isDrawer: boolean;
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
  /** When true, DialogContent renders as a side-sliding drawer instead of a centered modal. */
  isDrawer?: boolean;
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
        isDrawer: props.isDrawer ?? false,
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

type DialogContentProps = HTMLAttributes<HTMLElement> & {
  children: ReactNode;
  /** Width variant: "sm" (~360px), "default" (~440px), "lg" (~560px). Only used when not a drawer. */
  size?: 'sm' | 'default' | 'lg';
  /** Element to focus on open. Defaults to first focusable element. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** When true, clicking the backdrop does not close the dialog. */
  preventCloseOnOutsideClick?: boolean;
  /** ARIA role. Use "alertdialog" for confirmation prompts. Defaults to "dialog". */
  role?: 'dialog' | 'alertdialog';
  /** Which edge the drawer slides in from. Only meaningful when isDrawer is true. Defaults to "right". */
  side?: 'left' | 'right' | 'top' | 'bottom';
};

export function DialogContent({
  children,
  className,
  size,
  initialFocus,
  preventCloseOnOutsideClick,
  role,
  side = 'right',
  ...rest
}: DialogContentProps) {
  const ctx = useDialogContext();
  const portalRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const drawerPanelRef = useRef<HTMLElement>(null);
  const { open, onOpenChange, titleId, descriptionId, isDrawer } = ctx;
  const [exiting, setExiting] = useState(false);
  const prevOpenRef = useRef(open);

  // Track open->closed transitions to keep the panel mounted during the CSS
  // exit animation. Once the animation completes, useAnimationsFinished calls
  // clearExiting and the portal unmounts.
  // Drawers use CSS class toggling for open/close, not JS unmounting — skip.
  useEffect(() => {
    if (!isDrawer && prevOpenRef.current && !open) {
      setExiting(true);
    }
    prevOpenRef.current = open;
  }, [open, isDrawer]);

  const clearExiting = useCallback(() => setExiting(false), []);

  // Only use exit animation for modal dialogs — drawer uses CSS class toggle.
  useAnimationsFinished(panelRef, !isDrawer && exiting, clearExiting);

  const activePanelRef = (
    isDrawer ? drawerPanelRef : panelRef
  ) as RefObject<HTMLElement | null>;

  useScrollLock(open);
  useFocusTrap(activePanelRef, open, initialFocus);
  useEscapeKeydown(() => onOpenChange(false), open);
  useHideOthers(portalRef, open);

  const focusFirst = useCallback(() => {
    const items = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS) ??
        [],
    );
    items[0]?.focus({ preventScroll: true });
  }, []);

  const focusLast = useCallback(() => {
    const items = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS) ??
        [],
    );
    items[items.length - 1]?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' && open) {
      if (!document.getElementById(titleId)) {
        console.warn(
          'Dialog: no <DialogTitle> found. Add one for accessible labelling (aria-labelledby).',
        );
      }
    }
  }, [open, titleId]);

  if (typeof document === 'undefined') return null;

  if (isDrawer) {
    // Drawer: always mounted in the portal, open/closed controlled by CSS class.
    return createPortal(
      <div ref={portalRef}>
        <div
          data-sheet="overlay"
          className={cx(styles.overlay, open && styles.overlayVisible)}
          aria-hidden="true"
          onClick={() => !preventCloseOnOutsideClick && onOpenChange(false)}
        />
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is always dialog or alertdialog, both support aria-modal */}
        <section
          {...rest}
          ref={drawerPanelRef}
          role={role ?? 'dialog'}
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          data-sheet="content"
          data-side={side}
          data-state={open ? 'open' : 'closed'}
          className={cx(
            styles.drawer,
            styles[side as keyof typeof styles],
            open && styles.drawerOpen,
            className,
          )}
        >
          {children}
        </section>
      </div>,
      document.body,
    );
  }

  // Modal dialog (original behaviour).
  if (!open && !exiting) return null;

  const sizeClass =
    size === 'sm' ? styles.sm : size === 'lg' ? styles.lg : undefined;

  return createPortal(
    <div ref={portalRef}>
      <div
        className={cx(styles.backdrop, exiting && styles.exiting)}
        aria-hidden="true"
        onClick={() =>
          !exiting && !preventCloseOnOutsideClick && onOpenChange(false)
        }
      />
      <div className={styles.viewport}>
        <FocusGuard onFocus={focusLast} />
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is always dialog or alertdialog, both support aria-modal */}
        <div
          ref={panelRef}
          role={role ?? 'dialog'}
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          data-state={exiting ? 'closed' : 'open'}
          className={cx(
            styles.content,
            sizeClass,
            exiting && styles.exiting,
            className,
          )}
        >
          {children}
        </div>
        <FocusGuard onFocus={focusFirst} />
      </div>
    </div>,
    document.body,
  );
}

export function DialogHeader(props: {
  children: ReactNode;
  className?: string;
  visuallyHidden?: boolean;
}) {
  return (
    <div
      className={cx(
        props.visuallyHidden ? styles.srOnly : styles.header,
        props.className,
      )}
    >
      {props.children}
    </div>
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
