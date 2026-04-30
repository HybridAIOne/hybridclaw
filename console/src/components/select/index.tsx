import {
  type ButtonHTMLAttributes,
  createContext,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cx } from '../../lib/cx';
import {
  Popover,
  PopoverContent,
  type PopoverContentProps,
  usePopoverContext,
} from '../popover';
import {
  ScrollArea,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from '../scroll-area';
import css from './index.module.css';

type SelectContextValue = {
  value: string;
  selectValue: (value: string) => void;
  listEl: HTMLDivElement | null;
  setListEl: (el: HTMLDivElement | null) => void;
  listId: string;
  highlightedValue: string | null;
  setHighlightedValue: (v: string | null) => void;
  disabled: boolean;
  getItemId: (value: string) => string;
};

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
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
}

export function Select({
  value: valueProp,
  defaultValue = '',
  onValueChange,
  open,
  defaultOpen,
  onOpenChange,
  disabled = false,
  children,
}: SelectProps) {
  const isControlled = valueProp !== undefined;
  const [internalValue, setInternalValue] = useState(defaultValue);
  const value = isControlled ? valueProp : internalValue;
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const [highlightedValue, setHighlightedValue] = useState<string | null>(null);
  const listId = useId();
  const baseId = useId();

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
      value,
      selectValue,
      listEl,
      setListEl,
      listId,
      highlightedValue,
      setHighlightedValue,
      disabled,
      getItemId,
    }),
    [value, selectValue, listEl, listId, highlightedValue, disabled, getItemId],
  );

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (disabled && next) return;
      if (!next) setHighlightedValue(null);
      onOpenChange?.(next);
    },
    [disabled, onOpenChange],
  );

  return (
    <Popover
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={handleOpenChange}
    >
      <SelectContext.Provider value={ctx}>{children}</SelectContext.Provider>
    </Popover>
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
  const popover = usePopoverContext('SelectTrigger');
  const ctx = useSelectContext('SelectTrigger');
  return (
    <button
      ref={popover.setTriggerEl}
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={popover.open}
      aria-controls={popover.open ? ctx.listId : undefined}
      aria-disabled={ctx.disabled || undefined}
      data-state={popover.open ? 'open' : 'closed'}
      data-disabled={ctx.disabled ? '' : undefined}
      disabled={ctx.disabled}
      className={cx(css.trigger, className)}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (!popover.open) ctx.setHighlightedValue(ctx.value || null);
        popover.toggle();
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
          ctx.setHighlightedValue(ctx.value || null);
          popover.setOpen(true);
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

interface SelectContentProps
  extends Omit<PopoverContentProps, 'focusOnOpen' | 'children'> {
  /** Optional sticky header rendered above the listbox (e.g. a search input). */
  header?: ReactNode;
  /** Optional vertical rail rendered to the side of the listbox. */
  rail?: ReactNode;
  children: ReactNode;
}

const focusFirstInputOrList = (content: HTMLDivElement) => {
  const search = content.querySelector<HTMLInputElement>('input');
  if (search) {
    search.focus();
    return;
  }
  const list = content.querySelector<HTMLDivElement>('[role="listbox"]');
  list?.focus();
};

export function SelectContent({
  align = 'start',
  sideOffset = 6,
  header,
  rail,
  children,
  className,
  ...rest
}: SelectContentProps) {
  const popover = usePopoverContext('SelectContent');
  const ctx = useSelectContext('SelectContent');
  const typeaheadRef = useRef({ buffer: '', timer: 0 });
  const hasSearch = header != null && header !== false;
  const hasRail = rail != null && rail !== false;

  useEffect(() => {
    const popupEl = popover.contentEl;
    if (!popover.open || !popupEl || !ctx.highlightedValue) return;
    const activeId = ctx.getItemId(ctx.highlightedValue);
    const target = popupEl.querySelector<HTMLElement>(`#${cssEsc(activeId)}`);
    target?.scrollIntoView({ block: 'nearest' });
  }, [popover.open, popover.contentEl, ctx.highlightedValue, ctx.getItemId]);

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
    if (event.key === 'Tab') {
      popover.setOpen(false);
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
      popover.setOpen(false);
      popover.triggerEl?.focus();
      return;
    }
    if (!hasSearch && event.key === ' ' && ctx.highlightedValue != null) {
      event.preventDefault();
      ctx.selectValue(ctx.highlightedValue);
      popover.setOpen(false);
      popover.triggerEl?.focus();
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
    <PopoverContent
      align={align}
      sideOffset={sideOffset}
      focusOnOpen={focusFirstInputOrList}
      className={cx(css.popup, className)}
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
    </PopoverContent>
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
  const popover = usePopoverContext('SelectItem');
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
        popover.setOpen(false);
        popover.triggerEl?.focus();
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
