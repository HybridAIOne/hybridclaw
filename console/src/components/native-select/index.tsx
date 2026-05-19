import type { ComponentProps } from 'react';
import { cx } from '../../lib/cx';
import { useFieldControlProps } from '../field';
import { ChevronDown } from '../icons';
import styles from './native-select.module.css';

export type NativeSelectSize = 'default' | 'sm';

export type NativeSelectProps = Omit<ComponentProps<'select'>, 'size'> & {
  size?: NativeSelectSize;
};

const sizeClass: Record<NativeSelectSize, string> = {
  default: styles.sizeDefault,
  sm: styles.sizeSm,
};

export function NativeSelect({
  className,
  size = 'default',
  children,
  ...rest
}: NativeSelectProps) {
  const props = useFieldControlProps(rest);
  return (
    <div className={styles.wrapper} data-slot="native-select-wrapper">
      <select
        {...props}
        data-slot="native-select"
        data-size={size}
        className={cx(styles.select, sizeClass[size], className)}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className={styles.chevron}
        data-slot="native-select-icon"
      />
    </div>
  );
}

export type NativeSelectOptionProps = ComponentProps<'option'>;

export function NativeSelectOption({
  className,
  ...props
}: NativeSelectOptionProps) {
  return (
    <option
      {...props}
      data-slot="native-select-option"
      className={cx(styles.option, className)}
    />
  );
}

export type NativeSelectOptGroupProps = ComponentProps<'optgroup'>;

export function NativeSelectOptGroup({
  className,
  ...props
}: NativeSelectOptGroupProps) {
  return (
    <optgroup
      {...props}
      data-slot="native-select-optgroup"
      className={cx(styles.optgroup, className)}
    />
  );
}
