import {
  type ButtonHTMLAttributes,
  cloneElement,
  forwardRef,
  isValidElement,
  type MouseEvent,
  type ReactElement,
} from 'react';
import { cx } from '../../lib/cx';
import styles from './button.module.css';

export type ButtonVariant = 'default' | 'ghost' | 'outline' | 'danger';
export type ButtonSize = 'default' | 'sm' | 'icon';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  render?: ReactElement;
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
      loading = false,
      disabled,
      className,
      onClick,
      type,
      render,
      children,
      ...rest
    },
    ref,
  ) {
    const isInactive = disabled || loading;

    const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
      if (isInactive) {
        event.preventDefault();
        return;
      }
      onClick?.(event);
    };

    const baseClassName = cx(
      styles.button,
      variantClass[variant],
      sizeClass[size],
      className,
    );

    const dataAttrs = {
      'data-disabled': isInactive ? '' : undefined,
      'data-loading': loading ? '' : undefined,
    };

    if (render && isValidElement(render)) {
      const renderProps = render.props as {
        className?: string;
        children?: ReactElement;
      };
      return cloneElement(render, {
        ...rest,
        ref,
        className: cx(baseClassName, renderProps.className),
        'aria-disabled': isInactive || undefined,
        'aria-busy': loading || undefined,
        onClick: handleClick,
        children: children ?? renderProps.children,
        ...dataAttrs,
      } as Record<string, unknown>);
    }

    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        className={baseClassName}
        disabled={disabled}
        aria-disabled={loading || undefined}
        aria-busy={loading || undefined}
        onClick={handleClick}
        {...dataAttrs}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
