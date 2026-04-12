/**
 * Toast — a non-blocking notification system.
 *
 * Follows the provider + imperative hook pattern (à la Radix / Base UI): a provider wraps the app, and an
 * hook lets any component fire toasts.
 *
 * Setup (once, in app root):
 *   <ToastProvider>
 *     <App />
 *   </ToastProvider>
 *
 * Usage (anywhere inside the provider):
 *   const toast = useToast();
 *   toast.success('Saved.');
 *   toast.error('Something went wrong.');
 *   toast.info('FYI.');
 *   toast.add({ title: 'Custom', description: '…', type: 'default' });
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useExitAnimation } from '../../hooks/useExitAnimation';
import { cx } from '../../lib/cx';
import styles from './index.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface ToastManager {
  add: (options: ToastOptions) => string;
  success: (title: string, description?: string) => string;
  error: (title: string, description?: string) => string;
  info: (title: string, description?: string) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastManager | null>(null);

export function useToast(): ToastManager {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>.');
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

let nextId = 0;

export function ToastProvider(props: {
  children: ReactNode;
  /** Max visible toasts. Default: 3. */
  limit?: number;
}) {
  const limit = props.limit ?? 3;
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

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
        duration: options.duration ?? 5000,
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

  const success = useCallback(
    (title: string, description?: string) =>
      add({ title, description, type: 'success' }),
    [add],
  );

  const error = useCallback(
    (title: string, description?: string) =>
      add({ title, description, type: 'error' }),
    [add],
  );

  const info = useCallback(
    (title: string, description?: string) =>
      add({ title, description, type: 'info' }),
    [add],
  );

  // Escape dismisses the most recent toast, unless a dialog is open or focus is in a form input.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable
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

  const manager: ToastManager = { add, success, error, info, dismiss };

  return (
    <ToastContext.Provider value={manager}>
      {props.children}
      {typeof document !== 'undefined' &&
        createPortal(
          <ToastViewport
            toasts={toasts}
            onDismiss={dismiss}
            onRemove={remove}
          />,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Viewport (renders the toast stack)
// ---------------------------------------------------------------------------

function ToastViewport(props: {
  toasts: ToastEntry[];
  onDismiss: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  if (props.toasts.length === 0) return null;

  return (
    <div
      className={styles.viewport}
      aria-live="polite"
      aria-relevant="additions"
    >
      {props.toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onDismiss={props.onDismiss}
          onRemove={props.onRemove}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual toast
// ---------------------------------------------------------------------------

function ToastItem(props: {
  toast: ToastEntry;
  onDismiss: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const { toast, onDismiss, onRemove } = props;
  const elementRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(toast.duration);
  const startRef = useRef(0);

  useEffect(() => {
    if (toast.duration <= 0 || toast.exiting || paused) return;
    startRef.current = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), remainingRef.current);
    return () => {
      clearTimeout(timer);
      remainingRef.current -= Date.now() - startRef.current;
      if (remainingRef.current < 0) remainingRef.current = 0;
    };
  }, [toast.id, toast.duration, toast.exiting, paused, onDismiss]);

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
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
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
              toast.action?.onClick();
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
