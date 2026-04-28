import {
  type ButtonHTMLAttributes,
  createContext,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
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
import {
  ScrollArea,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from '../scroll-area';
import css from './index.module.css';

type SelectContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  value: string;
  selectValue: (value: string) => void;
  triggerEl: HTMLButtonElement | null;
  setTriggerEl: (el: HTMLButtonElement | null) => void;
  listEl: HTMLDivElement | null;
  setListEl: (el: HTMLDivElement | null) => void;
  listId: string;
  highlightedValue: string | null;
  setHighlightedValue: (v: string | null) => void;
  disabled: boolean;
  getItemId: (value: string) => string;
};

// Sentinel attribute used by SelectContent's focus effect to find the search
// input inside the popup; SelectSearch must set the matching attribute.
const SEARCH_ATTR = 'data-select-search';

const SelectContext = createContext<SelectContextValue | null>(null);

function useSelectContext(name: string): SelectContextValue {
  const ctx = useContext(SelectContext);
  if (!ctx) throw new Error(`${name} must be used within <Select>`);
  return ctx;
}

interface SelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  children: ReactNode;
}

export function Select({
  value: valueProp,
  defaultValue = '',
  onValueChange,
  disabled = false,
  children,
}: SelectProps) {
  const isControlled = valueProp !== undefined;
  const [internalValue, setInternalValue] = useState(defaultValue);
  const value = isControlled ? valueProp : internalValue;
  const [openState, setOpenState] = useState(false);
  const [triggerEl, setTriggerEl] = useState<HTMLButtonElement | null>(null);
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const [highlightedValue, setHighlightedValue] = useState<string | null>(null);
  const listId = useId();
  const baseId = useId();

  const setOpen = useCallback(
    (next: boolean) => {
      if (disabled && next) return;
      setOpenState(next);
    },
    [disabled],
  );

  const selectValue = useCallback(
    (next: string) => {
      if (!isControlled) setInternalValue(next);
      onValueChange?.(next);
    },
    [isControlled, onValueChange],
  );

  const getItemId = useCallback(
    (v: string) => `${baseId}-item-${cssId(v)}`,
    [baseId],
  );

  const ctx = useMemo<SelectContextValue>(
    () => ({
      open: openState,
      setOpen,
      value,
      selectValue,
      triggerEl,
      setTriggerEl,
      listEl,
      setListEl,
      listId,
      highlightedValue,
      setHighlightedValue,
      disabled,
      getItemId,
    }),
    [
      openState,
      setOpen,
      value,
      selectValue,
      triggerEl,
      listEl,
      listId,
      highlightedValue,
      disabled,
      getItemId,
    ],
  );

  return (
    <SelectContext.Provider value={ctx}>{children}</SelectContext.Provider>
  );
}

interface SelectTriggerProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode;
  className?: string;
}

export function SelectTrigger({
  children,
  className,
  onClick,
  onKeyDown,
  ...rest
}: SelectTriggerProps) {
  const ctx = useSelectContext('SelectTrigger');
  return (
    <button
      ref={ctx.setTriggerEl}
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={ctx.open}
      aria-controls={ctx.open ? ctx.listId : undefined}
      aria-disabled={ctx.disabled || undefined}
      data-state={ctx.open ? 'open' : 'closed'}
      data-disabled={ctx.disabled ? '' : undefined}
      disabled={ctx.disabled}
      className={cx(css.trigger, className)}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        ctx.setOpen(!ctx.open);
        if (!ctx.open) ctx.setHighlightedValue(ctx.value || null);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (
          event.key === 'ArrowDown' ||
          event.key === 'ArrowUp' ||
          event.key === 'Enter' ||
          event.key === ' '
        ) {
          event.preventDefault();
          ctx.setOpen(true);
          ctx.setHighlightedValue(ctx.value || null);
        }
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

interface SelectValueProps extends HTMLAttributes<HTMLSpanElement> {
  placeholder?: string;
  children?: ReactNode;
}

export function SelectValue({
  placeholder,
  children,
  className,
  ...rest
}: SelectValueProps) {
  const ctx = useSelectContext('SelectValue');
  const showPlaceholder =
    children == null || children === '' || ctx.value === '';
  return (
    <span
      className={cx(css.value, className)}
      data-placeholder={showPlaceholder ? '' : undefined}
      {...rest}
    >
      {showPlaceholder ? placeholder : children}
    </span>
  );
}

export function SelectIcon({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span aria-hidden="true" className={cx(css.icon, className)} {...rest}>
      {children ?? <ChevronIcon />}
    </span>
  );
}

function ChevronIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

interface SelectContentProps extends HTMLAttributes<HTMLDivElement> {
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  /** Optional sticky header rendered above the listbox (e.g. <SelectSearch>). */
  header?: ReactNode;
  /** Optional vertical rail rendered to the side of the listbox (e.g. <SelectRail>). */
  rail?: ReactNode;
  children: ReactNode;
}

export function SelectContent({
  align = 'start',
  sideOffset = 6,
  header,
  rail,
  children,
  className,
  ...rest
}: SelectContentProps) {
  const ctx = useSelectContext('SelectContent');
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{
    x: number;
    y: number;
    minWidth: number;
  } | null>(null);

  useLayoutEffect(() => {
    const popupEl = popupRef.current;
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
    const popupEl = popupRef.current;
    if (!ctx.open || !popupEl || !ctx.triggerEl) return;
    const trigger = ctx.triggerEl;

    const focusTimer = window.setTimeout(() => {
      const search = popupEl.querySelector<HTMLInputElement>(
        `input[${SEARCH_ATTR}]`,
      );
      if (search) {
        search.focus();
      } else {
        ctx.listEl?.focus();
      }
      const activeId = ctx.highlightedValue
        ? ctx.getItemId(ctx.highlightedValue)
        : null;
      const target = activeId
        ? popupEl.querySelector<HTMLElement>(`#${cssEsc(activeId)}`)
        : null;
      target?.scrollIntoView({ block: 'nearest' });
    }, 0);

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (trigger.contains(target) || popupEl.contains(target)) return;
      ctx.setOpen(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [
    ctx.open,
    ctx.listEl,
    ctx.triggerEl,
    ctx.highlightedValue,
    ctx.getItemId,
    ctx.setOpen,
  ]);

  if (!ctx.open) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <SelectPopup
      ref={popupRef}
      position={position}
      className={className}
      header={header}
      rail={rail}
      {...rest}
    >
      {children}
    </SelectPopup>,
    document.body,
  );
}

interface SelectPopupProps extends HTMLAttributes<HTMLDivElement> {
  position: { x: number; y: number; minWidth: number } | null;
  header: ReactNode;
  rail: ReactNode;
  ref: React.Ref<HTMLDivElement>;
}

function SelectPopup({
  ref,
  position,
  className,
  header,
  rail,
  children,
  ...rest
}: SelectPopupProps) {
  const hasSearch = header != null && header !== false;
  const hasRail = rail != null && rail !== false;
  const ctx = useSelectContext('SelectPopup');
  const typeaheadRef = useRef({ buffer: '', timer: 0 });

  useEffect(() => {
    const state = typeaheadRef.current;
    return () => {
      if (state.timer) window.clearTimeout(state.timer);
    };
  }, []);

  const navigableItems = useCallback(() => {
    if (!ctx.listEl) return [] as HTMLElement[];
    return Array.from(
      ctx.listEl.querySelectorAll<HTMLElement>(
        '[role="option"]:not([aria-disabled="true"])',
      ),
    );
  }, [ctx.listEl]);

  const moveHighlight = useCallback(
    (delta: number | 'first' | 'last') => {
      const items = navigableItems();
      if (items.length === 0) return;
      const currentIdx = ctx.highlightedValue
        ? items.findIndex(
            (el) => el.getAttribute('data-value') === ctx.highlightedValue,
          )
        : -1;
      let nextIdx: number;
      if (delta === 'first') nextIdx = 0;
      else if (delta === 'last') nextIdx = items.length - 1;
      else if (currentIdx < 0) nextIdx = delta > 0 ? 0 : items.length - 1;
      else nextIdx = (currentIdx + delta + items.length) % items.length;
      const nextEl = items[nextIdx];
      const nextVal = nextEl?.getAttribute('data-value') ?? null;
      ctx.setHighlightedValue(nextVal);
      nextEl?.scrollIntoView({ block: 'nearest' });
    },
    [navigableItems, ctx.highlightedValue, ctx.setHighlightedValue],
  );

  const commitTypeahead = (char: string) => {
    const state = typeaheadRef.current;
    state.buffer += char.toLowerCase();
    if (state.timer) window.clearTimeout(state.timer);
    state.timer = window.setTimeout(() => {
      state.buffer = '';
      state.timer = 0;
    }, 500);

    const items = navigableItems();
    if (items.length === 0) return;
    const currentIdx = ctx.highlightedValue
      ? items.findIndex(
          (el) => el.getAttribute('data-value') === ctx.highlightedValue,
        )
      : -1;
    const ordered = [
      ...items.slice(currentIdx + 1),
      ...items.slice(0, currentIdx + 1),
    ];
    const matched = ordered.find((el) =>
      (el.textContent ?? '').trim().toLowerCase().startsWith(state.buffer),
    );
    if (matched) {
      const nextVal = matched.getAttribute('data-value');
      ctx.setHighlightedValue(nextVal);
      matched.scrollIntoView({ block: 'nearest' });
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      ctx.setOpen(false);
      ctx.triggerEl?.focus();
      return;
    }
    if (event.key === 'Tab') {
      ctx.setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveHighlight(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveHighlight(-1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      moveHighlight('first');
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      moveHighlight('last');
      return;
    }
    if (event.key === 'Enter') {
      if (ctx.highlightedValue == null) return;
      event.preventDefault();
      ctx.selectValue(ctx.highlightedValue);
      ctx.setOpen(false);
      ctx.triggerEl?.focus();
      return;
    }
    if (!hasSearch && event.key === ' ' && ctx.highlightedValue != null) {
      event.preventDefault();
      ctx.selectValue(ctx.highlightedValue);
      ctx.setOpen(false);
      ctx.triggerEl?.focus();
      return;
    }
    if (
      !hasSearch &&
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      commitTypeahead(event.key);
    }
  };

  const activeDescendant = ctx.highlightedValue
    ? ctx.getItemId(ctx.highlightedValue)
    : undefined;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keyboard handler is on the popup wrapper to handle both search-input and listbox children
    <div
      ref={ref}
      className={cx(css.popup, className)}
      data-state="open"
      style={{
        left: position?.x ?? 0,
        top: position?.y ?? 0,
        minWidth: position?.minWidth,
        visibility: position ? 'visible' : 'hidden',
      }}
      onKeyDown={handleKeyDown}
      {...rest}
    >
      {hasSearch ? <div className={css.popupHeader}>{header}</div> : null}
      <div className={hasRail ? css.popupBody : css.popupBodyPlain}>
        {hasRail ? <div className={css.popupRail}>{rail}</div> : null}
        <ScrollArea className={css.listScroll}>
          <ScrollAreaViewport
            ref={ctx.setListEl}
            id={ctx.listId}
            role="listbox"
            tabIndex={-1}
            aria-activedescendant={activeDescendant}
            className={css.list}
          >
            {children}
          </ScrollAreaViewport>
          <ScrollAreaScrollbar>
            <ScrollAreaThumb />
          </ScrollAreaScrollbar>
        </ScrollArea>
      </div>
    </div>
  );
}

interface SelectSearchProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value: string;
  onValueChange: (value: string) => void;
}

export function SelectSearch({
  value,
  onValueChange,
  className,
  placeholder = 'Search…',
  ...rest
}: SelectSearchProps) {
  return (
    <div className={cx(css.search, className)}>
      <SearchIcon />
      <input
        type="text"
        autoComplete="off"
        spellCheck={false}
        {...{ [SEARCH_ATTR]: '' }}
        className={css.searchInput}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        {...rest}
      />
    </div>
  );
}

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function SelectRail({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="toolbar"
      aria-orientation="vertical"
      className={cx(css.rail, className)}
      {...rest}
    >
      {children}
    </div>
  );
}

interface SelectRailItemProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onSelect'> {
  active?: boolean;
  label: string;
  color?: string;
  icon?: ReactNode;
}

export function SelectRailItem({
  active = false,
  label,
  color,
  icon,
  className,
  ...rest
}: SelectRailItemProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      title={label}
      data-active={active ? '' : undefined}
      className={cx(css.railItem, className)}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={css.railGlyph}
        style={color ? { color } : undefined}
      >
        {icon ?? label.charAt(0).toUpperCase()}
      </span>
    </button>
  );
}

export function SelectGroup({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: <fieldset> would alter visual flow and form-control semantics; we want a non-form labeled group
    <div role="group" className={cx(css.group, className)} {...rest}>
      {children}
    </div>
  );
}

export function SelectGroupLabel({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx(css.groupLabel, className)} {...rest}>
      {children}
    </div>
  );
}

export function SelectSeparator({
  className,
  ...rest
}: HTMLAttributes<HTMLHRElement>) {
  return <hr className={cx(css.separator, className)} {...rest} />;
}

export function SelectEmpty({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx(css.empty, className)} {...rest}>
      {children}
    </div>
  );
}

interface SelectItemProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  value: string;
  disabled?: boolean;
  /** Optional accessible label override; defaults to the rendered text content. */
  textValue?: string;
  children: ReactNode;
}

export function SelectItem({
  value,
  disabled = false,
  textValue,
  children,
  className,
  onClick,
  onPointerEnter,
  ...rest
}: SelectItemProps) {
  const ctx = useSelectContext('SelectItem');
  const selected = ctx.value === value;
  const highlighted = ctx.highlightedValue === value;
  const itemId = ctx.getItemId(value);

  return (
    // biome-ignore lint/a11y/useFocusableInteractive: items use the aria-activedescendant pattern; focus stays on the listbox
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard events are handled by the parent listbox
    <div
      id={itemId}
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      aria-label={textValue}
      data-value={value}
      data-state={selected ? 'checked' : 'unchecked'}
      data-highlighted={highlighted ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      className={cx(css.item, className)}
      onClick={(event) => {
        if (disabled) return;
        onClick?.(event);
        if (event.defaultPrevented) return;
        ctx.selectValue(value);
        ctx.setOpen(false);
        ctx.triggerEl?.focus();
      }}
      onPointerEnter={(event) => {
        onPointerEnter?.(event);
        if (event.defaultPrevented) return;
        if (!disabled) ctx.setHighlightedValue(value);
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

export function SelectItemIndicator({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      aria-hidden="true"
      className={cx(css.itemIndicator, className)}
      {...rest}
    >
      {children ?? <CheckIcon />}
    </span>
  );
}

export function SelectItemText({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx(css.itemText, className)} {...rest}>
      {children}
    </span>
  );
}

export function SelectItemBody({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx(css.itemBody, className)} {...rest}>
      {children}
    </span>
  );
}

export function SelectItemSubtitle({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx(css.itemSubtitle, className)} {...rest}>
      {children}
    </span>
  );
}

export function SelectItemMeta({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx(css.itemMeta, className)} {...rest}>
      {children}
    </span>
  );
}

export function SelectBadge({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx(css.badge, className)} {...rest}>
      {children}
    </span>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12.5 10 17.5 19 7.5" />
    </svg>
  );
}

function cssId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function cssEsc(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}
