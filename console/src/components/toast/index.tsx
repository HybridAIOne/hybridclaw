import {
  createContext,
  forwardRef,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useExitAnimation } from '../../hooks/useExitAnimation';
import { cx } from '../../lib/cx';
import styles from './index.module.css';

export type ToastType = 'default' | 'success' | 'error' | 'info';

export interface ToastOptions {
  title: string;
  description?: string;
  type?: ToastType;
  /** Auto-dismiss after this many ms. 0 = no auto-dismiss. Default: 5000. */
  duration?: number;
  /** Optional action button. */
  action?: { label: string; onClick: () => void };
}

interface ToastEntry extends Required<Pick<ToastOptions, 'title' | 'type'>> {
  id: string;
  description?: string;
  duration: number;
  action?: { label: string; onClick: () => void };
  /** Set to true when the dismiss animation starts. */
  exiting: boolean;
}

interface ToastManager {
  add: (options: ToastOptions) => string;
  success: (title: string, description?: string) => string;
  error: (title: string, description?: string) => string;
  info: (title: string, description?: string) => string;
  /** Update an existing toast's content. Non-provided fields are unchanged. */
  update: (id: string, options: Partial<ToastOptions>) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastManager | null>(null);

export function useToast(): ToastManager {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>.');
  return ctx;
}

// Module-level counter for unique toast IDs. Not suitable for SSR.
let nextId = 0;

function clampDuration(value: number): number {
  return Math.max(0, value);
}

export function ToastProvider(props: {
  children: ReactNode;
  /** Max visible toasts. Default: 3. */
  limit?: number;
}) {
  const limit = props.limit ?? 3;
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [windowBlurred, setWindowBlurred] = useState(false);

  useEffect(() => {
    function onBlur() {
      setWindowBlurred(true);
    }
    function onFocus() {
      setWindowBlurred(false);
    }
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)),
    );
  }, []);

  const add = useCallback(
    (options: ToastOptions): string => {
      const id = `toast-${++nextId}`;
      const entry: ToastEntry = {
        id,
        title: options.title,
        description: options.description,
        type: options.type ?? 'default',
        duration: clampDuration(options.duration ?? 5000),
        action: options.action,
        exiting: false,
      };
      setToasts((prev) => {
        const next = [...prev, entry];
        // If over limit, mark oldest for exit.
        if (next.length > limit) {
          const overflow = next.length - limit;
          return next.map((t, i) =>
            i < overflow && !t.exiting ? { ...t, exiting: true } : t,
          );
        }
        return next;
      });
      return id;
    },
    [limit],
  );

  const update = useCallback((id: string, options: Partial<ToastOptions>) => {
    setToasts((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        const next = { ...t, ...options };
        if (options.duration !== undefined) {
          next.duration = clampDuration(options.duration);
        }
        return next;
      }),
    );
  }, []);

  const success = useCallback(
    (title: string, description?: string) =>
      add({ title, description, type: 'success' }),
    [add],
  );

  const error = useCallback(
    (title: string, description?: string) =>
      add({ title, description, type: 'error', duration: 0 }),
    [add],
  );

  const info = useCallback(
    (title: string, description?: string) =>
      add({ title, description, type: 'info' }),
    [add],
  );

  // Escape dismisses the most recent toast only when focus is inside the
  // toast viewport (Base UI pattern). When a modal is open its inert marking
  // prevents the viewport from receiving focus, so no cross-component
  // coordination is needed. F8 moves focus to the viewport (Radix convention).
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'F8') {
        viewportRef.current?.focus({ preventScroll: true });
        return;
      }
      if (e.key !== 'Escape') return;
      if (
        !viewportRef.current ||
        !viewportRef.current.contains(document.activeElement)
      )
        return;
      setToasts((prev) => {
        let last: ToastEntry | undefined;
        for (let i = prev.length - 1; i >= 0; i--) {
          if (!prev[i].exiting) {
            last = prev[i];
            break;
          }
        }
        if (!last) return prev;
        return prev.map((t) =>
          t.id === last.id ? { ...t, exiting: true } : t,
        );
      });
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const manager = useMemo<ToastManager>(
    () => ({ add, success, error, info, update, dismiss }),
    [add, success, error, info, update, dismiss],
  );

  return (
    <ToastContext.Provider value={manager}>
      {props.children}
      {typeof document !== 'undefined' &&
        createPortal(
          <ToastViewport
            ref={viewportRef}
            toasts={toasts}
            windowBlurred={windowBlurred}
            onDismiss={dismiss}
            onRemove={remove}
          />,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

const ToastViewport = forwardRef<
  HTMLDivElement,
  {
    toasts: ToastEntry[];
    windowBlurred: boolean;
    onDismiss: (id: string) => void;
    onRemove: (id: string) => void;
  }
>(function ToastViewport(props, ref) {
  return (
    <div
      ref={ref}
      className={styles.viewport}
      // No aria-live here — each toast item carries its own aria-live value
      // so error toasts use "assertive" while others use "polite".
      tabIndex={-1}
    >
      {props.toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          windowBlurred={props.windowBlurred}
          onDismiss={props.onDismiss}
          onRemove={props.onRemove}
        />
      ))}
    </div>
  );
});

function ToastItem(props: {
  toast: ToastEntry;
  windowBlurred: boolean;
  onDismiss: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const { toast, windowBlurred, onDismiss, onRemove } = props;
  const elementRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const [focused, setFocused] = useState(false);
  const remainingRef = useRef(toast.duration);
  const startRef = useRef(0);

  const suspended = paused || focused || windowBlurred;

  useEffect(() => {
    if (toast.duration <= 0 || toast.exiting || suspended) return;
    startRef.current = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), remainingRef.current);
    return () => {
      clearTimeout(timer);
      remainingRef.current -= Date.now() - startRef.current;
      if (remainingRef.current < 0) remainingRef.current = 0;
    };
  }, [toast.id, toast.duration, toast.exiting, suspended, onDismiss]);

  const handleRemove = useCallback(
    () => onRemove(toast.id),
    [onRemove, toast.id],
  );
  useExitAnimation(elementRef, toast.exiting, handleRemove);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: mouse handlers only control auto-dismiss pause, not user interactivity
    <div
      ref={elementRef}
      className={cx(
        styles.toast,
        toast.type === 'success' && styles.success,
        toast.type === 'error' && styles.error,
        toast.type === 'info' && styles.info,
        toast.exiting && styles.exiting,
      )}
      data-type={toast.type}
      role={toast.type === 'error' ? 'alert' : 'status'}
      aria-live={toast.type === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <div className={styles.body}>
        <p className={styles.title}>{toast.title}</p>
        {toast.description ? (
          <p className={styles.description}>{toast.description}</p>
        ) : null}
      </div>
      <div className={styles.actions}>
        {toast.action ? (
          <button
            type="button"
            className={styles.actionButton}
            onClick={() => {
              try {
                toast.action?.onClick();
              } catch (e) {
                console.error('Toast action callback failed:', e);
              }
              onDismiss(toast.id);
            }}
          >
            {toast.action.label}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.closeButton}
          aria-label="Dismiss"
          onClick={() => onDismiss(toast.id)}
        >
          &times;
        </button>
      </div>
    </div>
  );
}
