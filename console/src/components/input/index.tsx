import type { ComponentProps } from 'react';
import { cx } from '../../lib/cx';
import { useFieldControlProps } from '../field';
import styles from './input.module.css';

export type InputSize = 'default' | 'sm';

export type InputProps = Omit<ComponentProps<'input'>, 'size'> & {
  size?: InputSize;
};

const sizeClass: Record<InputSize, string> = {
  default: styles.sizeDefault,
  sm: styles.sizeSm,
};

export function Input({
  className,
  type = 'text',
  size = 'default',
  ...rest
}: InputProps) {
  const props = useFieldControlProps(rest);
  return (
    <input
      {...props}
      type={type}
      data-slot="input"
      data-size={size}
      className={cx(styles.input, sizeClass[size], className)}
    />
  );
}
