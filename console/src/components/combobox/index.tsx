import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cx } from '../../lib/cx';
import { useFieldControlProps } from '../field/context';
import { ChevronDown } from '../icons';
import { Input } from '../input';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  type PopoverContentProps,
} from '../popover';
import styles from './combobox.module.css';

export type ComboboxOption<TMeta = unknown> = {
  /** The value committed when this option is selected. */
  value: string;
  /** Human-readable label displayed in the list and (when selected) in the input. */
  label: string;
  /** Optional secondary line. */
  description?: string;
  /** Optional caller-defined metadata, passed back via `onValueChange`. */
  meta?: TMeta;
  /** When true, the option is rendered disabled and not selectable. */
  disabled?: boolean;
};

export type ComboboxProps<TMeta = unknown> = {
  value: string;
  onValueChange: (value: string, option: ComboboxOption<TMeta> | null) => void;
  options: ReadonlyArray<ComboboxOption<TMeta>>;
  placeholder?: string;
  disabled?: boolean;
  /** Override how an option renders inside the popover list. */
  renderOption?: (
    option: ComboboxOption<TMeta>,
    isActive: boolean,
  ) => React.ReactNode;
  /** Shown inside the popover when the filter yields zero matches. */
  emptyMessage?: React.ReactNode;
  /** Custom filter predicate. Default matches on label/value substring (case-insensitive). */
  filter?: (option: ComboboxOption<TMeta>, query: string) => boolean;
  /** Allow committing arbitrary text that isn't in `options`. Off by default. */
  allowFreeText?: boolean;
  /** Forwarded to the underlying popover for positioning. */
  popoverAlign?: PopoverContentProps['align'];
  className?: string;
  id?: string;
  /** Forwarded onBlur so callers can react to focus loss. */
  onBlur?: () => void;
};

const defaultFilter = <TMeta,>(
  option: ComboboxOption<TMeta>,
  query: string,
): boolean => {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    option.label.toLowerCase().includes(needle) ||
    option.value.toLowerCase().includes(needle)
  );
};

/**
 * Filterable single-select. The input is editable; typing narrows the
 * popover list. Selecting an option commits its `value` to the parent.
 *
 * When `allowFreeText` is false (default), focus loss without an exact
 * match snaps back to the previously-committed option's label.
 */
export function Combobox<TMeta = unknown>({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  renderOption,
  emptyMessage = 'No matches.',
  filter = defaultFilter,
  allowFreeText = false,
  popoverAlign = 'start',
  className,
  id,
  onBlur,
}: ComboboxProps<TMeta>) {
  const fieldProps = useFieldControlProps({ id, disabled });
  const generatedId = useId();
  const listboxId = `${fieldProps.id ?? generatedId}-listbox`;

  const selectedOption = useMemo(
    () => options.find((opt) => opt.value === value) ?? null,
    [options, value],
  );
  const labelForSelected = selectedOption
    ? selectedOption.label
    : allowFreeText
      ? value
      : '';

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(labelForSelected);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Set true by `commit` so an immediately-following blur (e.g. Tab
  // hands focus away after commit-on-Tab) doesn't try to commit again
  // against the stale closure value.
  const justCommittedRef = useRef(false);

  // When the parent updates value externally (or the selected option's
  // label changes) re-sync the input.
  useEffect(() => {
    if (!open) setQuery(labelForSelected);
  }, [labelForSelected, open]);

  const filtered = useMemo(
    () =>
      open
        ? options.filter((opt) => filter(opt, query.trim()))
        : (options as ReadonlyArray<ComboboxOption<TMeta>>),
    [options, open, query, filter],
  );

  useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(0);
  }, [filtered.length, activeIndex]);

  const commit = useCallback(
    (option: ComboboxOption<TMeta> | null, raw?: string) => {
      justCommittedRef.current = true;
      if (option) {
        onValueChange(option.value, option);
        setQuery(option.label);
      } else if (allowFreeText) {
        onValueChange(raw ?? '', null);
      }
      setOpen(false);
    },
    [allowFreeText, onValueChange],
  );

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
    setOpen(true);
    setActiveIndex(0);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) =>
        Math.min(current + 1, Math.max(0, filtered.length - 1)),
      );
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      if (!open) return;
      event.preventDefault();
      const target = filtered[activeIndex];
      if (target && !target.disabled) {
        commit(target);
      } else if (allowFreeText) {
        commit(null, query);
      }
    } else if (event.key === 'Escape') {
      if (!open) return;
      event.preventDefault();
      setOpen(false);
      setQuery(labelForSelected);
    } else if (event.key === 'Tab') {
      // Allow Tab to commit the highlighted option when the popover is open.
      if (!open) return;
      const target = filtered[activeIndex];
      if (target && !target.disabled) commit(target);
    }
  };

  const handleBlur = () => {
    setOpen(false);
    // commit() set this so a Tab-commit doesn't run the snap-back path
    // against the stale `value` closure on the way out.
    if (justCommittedRef.current) {
      justCommittedRef.current = false;
      onBlur?.();
      return;
    }
    if (!allowFreeText) {
      const match = options.find(
        (opt) => opt.label === query || opt.value === query,
      );
      if (!match) setQuery(labelForSelected);
      else if (match.value !== value) commit(match);
    } else if (query !== labelForSelected) {
      // Compare against the displayed label, not the raw `value`: when an
      // option's value differs from its label (value "apple" / label
      // "Apple"), an unedited focus→blur would otherwise re-commit the
      // label as free text and corrupt the committed value.
      commit(null, query);
    }
    onBlur?.();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor className={cx(styles.anchor, className)}>
        <Input
          {...fieldProps}
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          // `PopoverContent` unmounts when closed — only point at the
          // listbox while it actually exists in the DOM.
          aria-controls={open ? listboxId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={
            open && filtered[activeIndex]
              ? `${listboxId}-option-${activeIndex}`
              : undefined
          }
          value={query}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          className={styles.input}
          autoComplete="off"
          spellCheck={false}
        />
        <ChevronDown aria-hidden="true" className={styles.chevron} />
      </PopoverAnchor>
      <PopoverContent align={popoverAlign} className={styles.popover}>
        <div role="listbox" id={listboxId} className={styles.list}>
          {filtered.length === 0 ? (
            <div className={styles.empty}>{emptyMessage}</div>
          ) : (
            filtered.map((option, index) => {
              const isActive = index === activeIndex;
              const isSelected = option.value === value;
              return (
                <div
                  key={option.value}
                  id={`${listboxId}-option-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={option.disabled || undefined}
                  data-active={isActive || undefined}
                  data-disabled={option.disabled || undefined}
                  tabIndex={-1}
                  className={styles.option}
                  onMouseDown={(event) => {
                    // mousedown commits before the input's onBlur fires.
                    event.preventDefault();
                    if (!option.disabled) commit(option);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      if (!option.disabled) commit(option);
                    }
                  }}
                >
                  {renderOption ? (
                    renderOption(option, isActive)
                  ) : (
                    <>
                      <span className={styles.optionLabel}>{option.label}</span>
                      {option.description ? (
                        <span className={styles.optionDescription}>
                          {option.description}
                        </span>
                      ) : null}
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
