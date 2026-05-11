import { forwardRef, type HTMLAttributes } from 'react';
import { cx } from '../../lib/cx';
import styles from './card.module.css';

export type CardVariant = 'default' | 'muted';

export type CardProps = HTMLAttributes<HTMLDivElement> & {
  variant?: CardVariant;
};

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { variant = 'default', className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      data-slot="card"
      data-variant={variant}
      className={cx(styles.card, className)}
      {...rest}
    />
  );
});

export const CardHeader = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function CardHeader({ className, ...rest }, ref) {
  return (
    <div
      ref={ref}
      data-slot="card-header"
      className={cx(styles.header, className)}
      {...rest}
    />
  );
});

export const CardTitle = forwardRef<
  HTMLHeadingElement,
  HTMLAttributes<HTMLHeadingElement>
>(function CardTitle({ className, ...rest }, ref) {
  return (
    <h4
      ref={ref}
      data-slot="card-title"
      className={cx(styles.title, className)}
      {...rest}
    />
  );
});

export const CardDescription = forwardRef<
  HTMLParagraphElement,
  HTMLAttributes<HTMLParagraphElement>
>(function CardDescription({ className, ...rest }, ref) {
  return (
    <p
      ref={ref}
      data-slot="card-description"
      className={cx(styles.description, className)}
      {...rest}
    />
  );
});

export const CardAction = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function CardAction({ className, ...rest }, ref) {
  return (
    <div
      ref={ref}
      data-slot="card-action"
      className={cx(styles.action, className)}
      {...rest}
    />
  );
});

export const CardContent = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function CardContent({ className, ...rest }, ref) {
  return (
    <div
      ref={ref}
      data-slot="card-content"
      className={cx(styles.content, className)}
      {...rest}
    />
  );
});

export const CardFooter = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function CardFooter({ className, ...rest }, ref) {
  return (
    <div
      ref={ref}
      data-slot="card-footer"
      className={cx(styles.footer, className)}
      {...rest}
    />
  );
});
