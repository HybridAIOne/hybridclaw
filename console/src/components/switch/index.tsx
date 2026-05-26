import type { ButtonHTMLAttributes, MouseEvent } from 'react';
import { cx } from '../../lib/cx';
import { useFieldContext, useFieldControlProps } from '../field';
import styles from './switch.module.css';

export type SwitchSize = 'default' | 'sm';

export type SwitchProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'onChange' | 'value' | 'type'
> & {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  size?: SwitchSize;
  /**
   * When set, a hidden form input is emitted *only while checked and enabled*,
   * mirroring native checkbox submit semantics (disabled controls are excluded
   * from submission). Forms that need an explicit "off" value should read state
   * directly rather than relying on form serialization.
   */
  name?: string;
  value?: string;
  required?: boolean;
};

const sizeClass: Record<SwitchSize, string> = {
  default: styles.sizeDefault,
  sm: styles.sizeSm,
};

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  size = 'default',
  className,
  onClick,
  name,
  value = 'on',
  required,
  ...rest
}: SwitchProps) {
  // `required` only feeds `aria-required` here; the literal `required`
  // attribute is invalid on a <button>, so omit it from the spread.
  const { required: _required, ...props } = useFieldControlProps({
    disabled,
    required,
    ...rest,
  });
  const field = useFieldContext();
  const state = checked ? 'checked' : 'unchecked';
  const isDisabled = props.disabled;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (isDisabled) return;
    onClick?.(event);
    if (event.defaultPrevented) return;
    // Button-based controls don't fire native input/change events, so
    // the surrounding Field's auto-touch listener misses this toggle.
    field.setTouched(true);
    onCheckedChange?.(!checked);
  };

  return (
    <>
      <button
        {...props}
        type="button"
        role="switch"
        aria-checked={checked}
        data-slot="switch"
        data-state={state}
        data-size={size}
        className={cx(styles.root, sizeClass[size], className)}
        onClick={handleClick}
      >
        <span
          aria-hidden="true"
          data-slot="switch-thumb"
          data-state={state}
          className={styles.thumb}
        />
      </button>
      {name && checked && !isDisabled ? (
        <input type="hidden" name={name} value={value} />
      ) : null}
    </>
  );
}
