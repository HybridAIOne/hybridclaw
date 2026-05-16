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
import { Circle } from '../icons';
import styles from './radio-group.module.css';

type Orientation = 'horizontal' | 'vertical';

type RadioGroupContextValue = {
  name: string | undefined;
  value: string | undefined;
  setValue: (next: string) => void;
  disabled?: boolean;
  required?: boolean;
  orientation: Orientation;
  registerItem: (value: string, el: HTMLButtonElement) => () => void;
  focusValue: (currentValue: string, direction: 1 | -1) => void;
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
  ...props
}: RadioGroupProps) {
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
      let nextIndex = currentIndex + direction;
      if (loop) {
        nextIndex = (nextIndex + values.length) % values.length;
      } else if (nextIndex < 0 || nextIndex >= values.length) {
        return;
      }
      itemsRef.current.get(values[nextIndex])?.focus();
    },
    [loop],
  );

  const ctx = useMemo<RadioGroupContextValue>(
    () => ({
      name,
      value,
      setValue,
      disabled,
      required,
      orientation,
      registerItem,
      focusValue,
      loop,
    }),
    [
      name,
      value,
      setValue,
      disabled,
      required,
      orientation,
      registerItem,
      focusValue,
      loop,
    ],
  );

  return (
    <RadioGroupContext.Provider value={ctx}>
      <div
        role="radiogroup"
        aria-orientation={orientation}
        aria-disabled={disabled || undefined}
        aria-required={required || undefined}
        data-slot="radio-group"
        data-orientation={orientation}
        className={cx(styles.root, className)}
        {...props}
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
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: button-with-role lets the indicator be styled
    <button
      ref={buttonRef}
      type="button"
      role="radio"
      aria-checked={checked}
      name={ctx.name}
      data-slot="radio-group-item"
      data-state={state}
      data-value={value}
      disabled={isDisabled}
      tabIndex={tabIndex}
      className={cx(styles.item, className)}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      {...props}
    >
      {checked ? (
        <Circle aria-hidden="true" className={styles.indicator} />
      ) : null}
    </button>
  );
}
