import type { ComponentProps } from 'react';
import { cx } from '../../lib/cx';
import styles from './label.module.css';

export type LabelProps = ComponentProps<'label'>;

export function Label({ className, ...props }: LabelProps) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: htmlFor/children are caller-supplied
    <label
      data-slot="label"
      className={cx(styles.label, className)}
      {...props}
    />
  );
}
