import type { ComponentProps } from 'react';
import { cx } from '../../lib/cx';
import { useFieldControlProps } from '../field/context';
import styles from './textarea.module.css';

export type TextareaProps = ComponentProps<'textarea'> & {
  autoSize?: boolean;
};

export function Textarea({
  className,
  autoSize = false,
  ...rest
}: TextareaProps) {
  const props = useFieldControlProps(rest);
  return (
    <textarea
      data-slot="textarea"
      data-auto-size={autoSize ? '' : undefined}
      className={cx(styles.textarea, autoSize && styles.autoSize, className)}
      {...props}
    />
  );
}
