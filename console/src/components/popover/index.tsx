import {
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../lib/cx';
import css from './index.module.css';

type PopoverContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  triggerEl: HTMLElement | null;
  setTriggerEl: (el: HTMLElement | null) => void;
  contentEl: HTMLDivElement | null;
  setContentEl: (el: HTMLDivElement | null) => void;
  contentId: string;
};

const PopoverContext = createContext<PopoverContextValue | null>(null);

export function usePopoverContext(name: string): PopoverContextValue {
  const ctx = useContext(PopoverContext);
  if (!ctx) throw new Error(`${name} must be used within <Popover>`);
  return ctx;
}

interface PopoverProps {
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function Popover({
  children,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
}: PopoverProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const [triggerEl, setTriggerEl] = useState<HTMLElement | null>(null);
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null);
  const contentId = useId();

  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : internalOpen;

  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);

  const value = useMemo<PopoverContextValue>(
    () => ({
      open,
      setOpen,
      toggle,
      triggerEl,
      setTriggerEl,
      contentEl,
      setContentEl,
      contentId,
    }),
    [open, setOpen, toggle, triggerEl, contentEl, contentId],
  );

  return (
    <PopoverContext.Provider value={value}>{children}</PopoverContext.Provider>
  );
}

export type PopoverAlign = 'start' | 'center' | 'end';

export interface PopoverContentProps extends HTMLAttributes<HTMLDivElement> {
  align?: PopoverAlign;
  sideOffset?: number;
  /**
   * How to focus content when the popover opens.
   *  - 'first-button': move focus to the first non-disabled <button> in content (menu pattern)
   *  - 'none': skip auto-focus (caller manages focus, e.g. listbox with aria-activedescendant)
   *  - function: caller-provided strategy, receives the content element
   */
  focusOnOpen?:
    | 'first-button'
    | 'none'
    | ((content: HTMLDivElement) => void);
  /** When true, Escape closes the popover and returns focus to the trigger. Defaults to true. */
  closeOnEscape?: boolean;
  /** When true, mousedown outside the popover closes it. Defaults to true. */
  closeOnOutsideClick?: boolean;
  ref?: Ref<HTMLDivElement>;
}

export function PopoverContent({
  align = 'start',
  sideOffset = 4,
  focusOnOpen = 'first-button',
  closeOnEscape = true,
  closeOnOutsideClick = true,
  className,
  style,
  children,
  ref,
  ...rest
}: PopoverContentProps) {
  const ctx = usePopoverContext('PopoverContent');
  const localRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number; minWidth: number } | null>(
    null,
  );

  const { setContentEl } = ctx;
  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      localRef.current = node;
      setContentEl(node);
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as React.RefObject<HTMLDivElement | null>).current = node;
    },
    [setContentEl, ref],
  );

  useLayoutEffect(() => {
    const popupEl = localRef.current;
    if (!ctx.open || !ctx.triggerEl || !popupEl) return;
    const updatePosition = () => {
      if (!ctx.triggerEl || !popupEl) return;
      const triggerRect = ctx.triggerEl.getBoundingClientRect();
      const contentRect = popupEl.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let x = triggerRect.left;
      if (align === 'end') x = triggerRect.right - contentRect.width;
      else if (align === 'center')
        x = triggerRect.left + (triggerRect.width - contentRect.width) / 2;
      let y = triggerRect.bottom + sideOffset;
      if (x + contentRect.width > vw - 8) x = vw - contentRect.width - 8;
      if (x < 8) x = 8;
      if (y + contentRect.height > vh - 8) {
        const flipped = triggerRect.top - contentRect.height - sideOffset;
        if (flipped >= 8) y = flipped;
      }
      setPosition({ x, y, minWidth: triggerRect.width });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [ctx.open, ctx.triggerEl, align, sideOffset]);

  useEffect(() => {
    const popupEl = localRef.current;
    if (!ctx.open || !popupEl) return;
    if (focusOnOpen === 'none') return;
    const timer = window.setTimeout(() => {
      if (focusOnOpen === 'first-button') {
        const firstButton = popupEl.querySelector<HTMLElement>(
          'button:not(:disabled)',
        );
        firstButton?.focus();
      } else {
        focusOnOpen(popupEl);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [ctx.open, focusOnOpen]);

  useEffect(() => {
    if (!ctx.open || !closeOnOutsideClick) return;
    const popupEl = localRef.current;
    const trigger = ctx.triggerEl;
    if (!popupEl || !trigger) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (trigger.contains(target) || popupEl.contains(target)) return;
      ctx.setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [ctx.open, ctx.triggerEl, ctx.setOpen, closeOnOutsideClick]);

  useEffect(() => {
    if (!ctx.open || !closeOnEscape) return;
    const trigger = ctx.triggerEl;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      ctx.setOpen(false);
      if (trigger && 'focus' in trigger) trigger.focus();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [ctx.open, ctx.triggerEl, ctx.setOpen, closeOnEscape]);

  if (!ctx.open) return null;
  if (typeof document === 'undefined') return null;

  const positionStyle: CSSProperties = {
    left: position?.x ?? 0,
    top: position?.y ?? 0,
    minWidth: position?.minWidth,
    visibility: position ? 'visible' : 'hidden',
  };

  return createPortal(
    <div
      ref={setRefs}
      id={ctx.contentId}
      data-state="open"
      className={cx(css.content, className)}
      style={{ ...positionStyle, ...style }}
      {...rest}
    >
      {children}
    </div>,
    document.body,
  );
}
