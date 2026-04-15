import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cx } from '../lib/cx';
import styles from './button.module.css';

export type ButtonVariant = 'default' | 'ghost' | 'outline' | 'danger';
export type ButtonSize = 'default' | 'sm' | 'icon';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

const variantClass: Record<ButtonVariant, string> = {
  default: styles.default,
  ghost: styles.ghost,
  outline: styles.outline,
  danger: styles.danger,
};

const sizeClass: Record<ButtonSize, string> = {
  default: styles.sizeDefault,
  sm: styles.sizeSm,
  icon: styles.sizeIcon,
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = 'default',
      size = 'default',
      className,
      type = 'button',
      ...props
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        className={cx(
          styles.button,
          variantClass[variant],
          sizeClass[size],
          className,
        )}
        {...props}
      />
    );
  },
);
