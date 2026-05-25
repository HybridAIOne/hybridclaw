import {
  type ButtonHTMLAttributes,
  type ComponentProps,
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cx } from '../../lib/cx';
import { mergeIds, useFieldContext } from '../field/context';
import { Circle } from '../icons';
import styles from './radio-group.module.css';

type Orientation = 'horizontal' | 'vertical';

type RadioGroupContextValue = {
  name: string | undefined;
  value: string | undefined;
  setValue: (next: string) => void;
  disabled?: boolean;
  required?: boolean;
  invalid?: boolean;
  orientation: Orientation;
  registerItem: (value: string, el: HTMLButtonElement) => () => void;
  focusValue: (currentValue: string, direction: 1 | -1) => void;
  focusEdge: (edge: 'first' | 'last') => void;
  loop: boolean;
};

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null);

function useRadioGroupContext(name: string): RadioGroupContextValue {
  const ctx = useContext(RadioGroupContext);
  if (!ctx) {
    throw new Error(`${name} must be used inside <RadioGroup>`);
  }
  return ctx;
}

export type RadioGroupProps = Omit<ComponentProps<'div'>, 'onChange'> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  orientation?: Orientation;
  loop?: boolean;
};

export function RadioGroup({
  value: valueProp,
  defaultValue,
  onValueChange,
  name,
  disabled,
  required,
  orientation = 'vertical',
  loop = true,
  className,
  children,
  id,
  'aria-invalid': ariaInvalidProp,
  'aria-describedby': ariaDescribedByProp,
  'aria-label': ariaLabelProp,
  'aria-labelledby': ariaLabelledByProp,
  ...props
}: RadioGroupProps) {
  const field = useFieldContext();
  const resolvedDisabled = disabled ?? field.disabled;
  const resolvedInvalid =
    ariaInvalidProp === undefined
      ? field.invalid
      : ariaInvalidProp === true || ariaInvalidProp === 'true';
  const describedBy = mergeIds(
    field.descriptionId,
    resolvedInvalid ? field.errorId : undefined,
    ariaDescribedByProp,
  );
  // A `role="radiogroup"` div isn't a labelable element, so the surrounding
  // <FieldLabel>'s `htmlFor` can't name it. Point at the label's id instead.
  // Caller-supplied aria-labelledby / aria-label always win.
  const labelledBy =
    ariaLabelledByProp ?? (ariaLabelProp ? undefined : field.labelId);
  const isControlled = valueProp !== undefined;
  const [internalValue, setInternalValue] = useState<string | undefined>(
    defaultValue,
  );
  const value = isControlled ? valueProp : internalValue;

  const itemsRef = useRef<Map<string, HTMLButtonElement>>(new Map());

  const registerItem = useCallback(
    (itemValue: string, el: HTMLButtonElement) => {
      itemsRef.current.set(itemValue, el);
      return () => {
        const current = itemsRef.current.get(itemValue);
        if (current === el) {
          itemsRef.current.delete(itemValue);
        }
      };
    },
    [],
  );

  const setValue = useCallback(
    (next: string) => {
      if (!isControlled) setInternalValue(next);
      onValueChange?.(next);
    },
    [isControlled, onValueChange],
  );

  const focusValue = useCallback(
    (currentValue: string, direction: 1 | -1) => {
      const values = Array.from(itemsRef.current.keys());
      if (values.length === 0) return;
      const currentIndex = values.indexOf(currentValue);
      // Step in `direction`, skipping disabled (and thus unfocusable) items
      // so navigation doesn't stall on one. Bounded by the item count so an
      // all-disabled group can't loop forever.
      for (let step = 1; step <= values.length; step += 1) {
        let nextIndex = currentIndex + direction * step;
        if (loop) {
          nextIndex =
            ((nextIndex % values.length) + values.length) % values.length;
        } else if (nextIndex < 0 || nextIndex >= values.length) {
          return;
        }
        const el = itemsRef.current.get(values[nextIndex]);
        if (el && !el.disabled) {
          el.focus();
          return;
        }
      }
    },
    [loop],
  );

  const focusEdge = useCallback((edge: 'first' | 'last') => {
    const values = Array.from(itemsRef.current.keys());
    const ordered = edge === 'first' ? values : values.reverse();
    for (const itemValue of ordered) {
      const el = itemsRef.current.get(itemValue);
      if (el && !el.disabled) {
        el.focus();
        return;
      }
    }
  }, []);

  const ctx = useMemo<RadioGroupContextValue>(
    () => ({
      name,
      value,
      setValue,
      disabled: resolvedDisabled,
      required,
      invalid: resolvedInvalid,
      orientation,
      registerItem,
      focusValue,
      focusEdge,
      loop,
    }),
    [
      name,
      value,
      setValue,
      resolvedDisabled,
      required,
      resolvedInvalid,
      orientation,
      registerItem,
      focusValue,
      focusEdge,
      loop,
    ],
  );

  return (
    <RadioGroupContext.Provider value={ctx}>
      <div
        {...props}
        id={id ?? field.id}
        role="radiogroup"
        aria-orientation={orientation}
        aria-label={ariaLabelProp}
        aria-labelledby={labelledBy}
        aria-disabled={resolvedDisabled || undefined}
        aria-required={required || undefined}
        aria-invalid={resolvedInvalid || undefined}
        aria-describedby={describedBy}
        data-slot="radio-group"
        data-orientation={orientation}
        className={cx(styles.root, className)}
      >
        {children}
      </div>
    </RadioGroupContext.Provider>
  );
}

export type RadioGroupItemProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'value' | 'onChange' | 'type'
> & {
  value: string;
};

export function RadioGroupItem({
  value,
  disabled,
  className,
  onClick,
  onKeyDown,
  ...props
}: RadioGroupItemProps) {
  const ctx = useRadioGroupContext('<RadioGroupItem>');
  const field = useFieldContext();
  const { registerItem } = ctx;
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const el = buttonRef.current;
    if (!el) return;
    return registerItem(value, el);
  }, [registerItem, value]);

  const checked = ctx.value === value;
  const state = checked ? 'checked' : 'unchecked';
  const isDisabled = disabled || ctx.disabled;
  const hasSelection = ctx.value !== undefined;
  // When the group has a selection only the selected item is in the tab order;
  // when nothing is selected, every item is tab-focusable so the group itself
  // remains reachable. Arrow keys handle intra-group movement either way.
  const tabIndex = !hasSelection || checked ? 0 : -1;

  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (isDisabled) return;
    onClick?.(event);
    if (event.defaultPrevented) return;
    // Button-based controls don't fire native input/change events;
    // mark the surrounding Field touched so error visibility tracks
    // the user's selection.
    field.setTouched(true);
    ctx.setValue(value);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || isDisabled) return;
    const isHorizontal = ctx.orientation === 'horizontal';
    const nextKey = isHorizontal ? 'ArrowRight' : 'ArrowDown';
    const prevKey = isHorizontal ? 'ArrowLeft' : 'ArrowUp';
    if (event.key === nextKey) {
      event.preventDefault();
      ctx.focusValue(value, 1);
    } else if (event.key === prevKey) {
      event.preventDefault();
      ctx.focusValue(value, -1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      ctx.focusEdge('first');
    } else if (event.key === 'End') {
      event.preventDefault();
      ctx.focusEdge('last');
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: button-with-role lets the indicator be styled
    <button
      {...props}
      ref={buttonRef}
      type="button"
      role="radio"
      aria-checked={checked}
      aria-invalid={ctx.invalid || undefined}
      name={ctx.name}
      data-slot="radio-group-item"
      data-state={state}
      data-value={value}
      disabled={isDisabled}
      tabIndex={tabIndex}
      className={cx(styles.item, className)}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {checked ? (
        <Circle aria-hidden="true" className={styles.indicator} />
      ) : null}
    </button>
  );
}
