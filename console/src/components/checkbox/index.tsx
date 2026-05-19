import type { ButtonHTMLAttributes, MouseEvent } from 'react';
import { cx } from '../../lib/cx';
import { useFieldControlProps } from '../field';
import { Check, Minus } from '../icons';
import styles from './checkbox.module.css';

export type CheckedState = boolean | 'indeterminate';

export type CheckboxProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'onChange' | 'value' | 'type'
> & {
  checked: CheckedState;
  onCheckedChange?: (checked: boolean) => void;
  name?: string;
  value?: string;
  required?: boolean;
};

export function Checkbox({
  checked,
  onCheckedChange,
  disabled,
  className,
  onClick,
  name,
  value = 'on',
  required,
  ...rest
}: CheckboxProps) {
  const props = useFieldControlProps({ disabled, ...rest });
  const isDisabled = props.disabled;

  const state =
    checked === 'indeterminate'
      ? 'indeterminate'
      : checked
        ? 'checked'
        : 'unchecked';

  const ariaChecked: boolean | 'mixed' =
    checked === 'indeterminate' ? 'mixed' : checked;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (isDisabled) return;
    onClick?.(event);
    if (event.defaultPrevented) return;
    onCheckedChange?.(checked !== true);
  };

  const IndicatorIcon =
    checked === 'indeterminate' ? Minus : checked ? Check : null;

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: button-with-role lets the indicator be styled */}
      <button
        {...props}
        type="button"
        role="checkbox"
        aria-checked={ariaChecked}
        aria-required={required || undefined}
        data-slot="checkbox"
        data-state={state}
        className={cx(styles.root, className)}
        onClick={handleClick}
      >
        <span aria-hidden="true" className={styles.indicator}>
          {IndicatorIcon ? <IndicatorIcon className={styles.icon} /> : null}
        </span>
      </button>
      {name && checked === true ? (
        <input type="hidden" name={name} value={value} />
      ) : null}
    </>
  );
}
