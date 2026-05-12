import { forwardRef, type HTMLAttributes } from 'react';
import { cx } from '../../lib/cx';
import styles from './skeleton.module.css';

export type SkeletonProps = HTMLAttributes<HTMLDivElement>;

export const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(
  function Skeleton({ className, ...rest }, ref) {
    return (
      <div
        ref={ref}
        data-slot="skeleton"
        className={cx(styles.skeleton, className)}
        {...rest}
      />
    );
  },
);
