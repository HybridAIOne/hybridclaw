import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react';
import { useStableCallback } from '../../lib/use-stable-callback';
import { cx } from '../../lib/cx';
import { Label } from '../label';
import { FieldContext, useFieldContext } from './context';
import styles from './field.module.css';

export type { FieldContextValue } from './context';
export { useFieldContext, useFieldControlProps } from './context';
export { useFieldError } from './use-field-error';
export type { Validator } from './validators';
export {
  compose,
  loopbackUrl,
  maxLength,
  minLength,
  oneOf,
  pattern,
  required,
  url,
} from './validators';

export type FieldOrientation = 'vertical' | 'horizontal' | 'responsive';

const orientationClass: Record<FieldOrientation, string> = {
  vertical: styles.orientationVertical,
  horizontal: styles.orientationHorizontal,
  responsive: styles.orientationResponsive,
};

export type FieldSetProps = ComponentProps<'fieldset'>;

export function FieldSet({ className, ...props }: FieldSetProps) {
  return (
    <fieldset
      data-slot="field-set"
      className={cx(styles.fieldSet, className)}
      {...props}
    />
  );
}

export type FieldLegendVariant = 'legend' | 'label';

export type FieldLegendProps = ComponentProps<'legend'> & {
  variant?: FieldLegendVariant;
};

export function FieldLegend({
  className,
  variant = 'legend',
  ...props
}: FieldLegendProps) {
  return (
    <legend
      data-slot="field-legend"
      data-variant={variant}
      className={cx(styles.legend, className)}
      {...props}
    />
  );
}

export type FieldGroupProps = ComponentProps<'div'>;

export function FieldGroup({ className, ...props }: FieldGroupProps) {
  return (
    <div
      data-slot="field-group"
      className={cx(styles.group, className)}
      {...props}
    />
  );
}

export type FieldProps = ComponentProps<'div'> & {
  orientation?: FieldOrientation;
  /**
   * Optional manual override. When unset, the field derives its invalid
   * state from the most recently set error string (any descendant control
   * that calls `useFieldContext().setError` reports here).
   */
  invalid?: boolean;
  disabled?: boolean;
  /**
   * Override the auto-generated control id. Useful when a single Field wraps
   * multiple controls and the consumer wants to manage the id manually.
   */
  controlId?: string;
  /**
   * Subscribe to error-state changes. Fires whenever the field's error
   * string changes (including transitions to `null`).
   */
  onErrorChange?: (error: string | null) => void;
  /**
   * Controlled error — when provided, takes priority over any internal
   * state set by descendant controls. Useful for piping a
   * `useFieldError` result onto a Field that wraps a raw `<Input>`.
   */
  error?: string | null;
};

export function Field({
  className,
  orientation = 'vertical',
  invalid,
  disabled,
  controlId,
  onErrorChange,
  error: errorProp,
  ...props
}: FieldProps) {
  const generatedId = useId();
  const id = controlId ?? generatedId;
  const [internalError, setErrorState] = useState<string | null>(null);
  const reportError = useStableCallback(onErrorChange ?? noop);

  const setError = useCallback((next: string | null) => {
    setErrorState((current) => (current === next ? current : next));
  }, []);

  const error = errorProp !== undefined ? errorProp : internalError;

  useEffect(() => {
    reportError(error);
  }, [error, reportError]);

  // Only flip aria-invalid on when there's a reason — either an explicit
  // override or a tracked error. Otherwise leave it undefined so the
  // attribute isn't emitted at all.
  const derivedInvalid =
    invalid !== undefined ? invalid : error !== null ? true : undefined;

  const ctx = useMemo(
    () => ({
      id,
      descriptionId: `${id}-description`,
      errorId: `${id}-error`,
      invalid: derivedInvalid,
      disabled,
      error,
      setError,
    }),
    [id, derivedInvalid, disabled, error, setError],
  );

  return (
    <FieldContext.Provider value={ctx}>
      <div
        data-slot="field"
        data-orientation={orientation}
        data-invalid={derivedInvalid || undefined}
        data-disabled={disabled || undefined}
        className={cx(styles.field, orientationClass[orientation], className)}
        {...props}
      />
    </FieldContext.Provider>
  );
}

function noop(): void {}

export type FieldContentProps = ComponentProps<'div'>;

export function FieldContent({ className, ...props }: FieldContentProps) {
  return (
    <div
      data-slot="field-content"
      className={cx(styles.content, className)}
      {...props}
    />
  );
}

export type FieldLabelProps = ComponentProps<typeof Label>;

export function FieldLabel({ className, htmlFor, ...props }: FieldLabelProps) {
  const field = useFieldContext();
  return (
    <Label
      data-slot="field-label"
      htmlFor={htmlFor ?? field.id}
      className={cx(styles.label, className)}
      {...props}
    />
  );
}

export type FieldTitleProps = ComponentProps<'div'>;

export function FieldTitle({ className, ...props }: FieldTitleProps) {
  return (
    <div
      data-slot="field-title"
      className={cx(styles.title, className)}
      {...props}
    />
  );
}

export type FieldDescriptionProps = ComponentProps<'p'>;

export function FieldDescription({
  className,
  id,
  ...props
}: FieldDescriptionProps) {
  const field = useFieldContext();
  return (
    <p
      data-slot="field-description"
      id={id ?? field.descriptionId}
      className={cx(styles.description, className)}
      {...props}
    />
  );
}

export type FieldErrorProps = ComponentProps<'div'> & {
  errors?: Array<{ message?: string } | undefined>;
};

function resolveErrorContent(
  children: ReactNode,
  errors: FieldErrorProps['errors'],
  contextError: string | null,
): ReactNode {
  if (children) return children;
  if (errors?.length) {
    const unique = [
      ...new Map(errors.map((error) => [error?.message, error])).values(),
    ].filter((error): error is { message?: string } =>
      Boolean(error?.message),
    );

    if (unique.length === 0) return contextError;
    if (unique.length === 1) return unique[0]?.message;

    return (
      <ul className={styles.errorList}>
        {unique.map((error) => (
          <li key={error.message}>{error.message}</li>
        ))}
      </ul>
    );
  }
  return contextError;
}

export function FieldError({
  className,
  children,
  errors,
  id,
  ...props
}: FieldErrorProps) {
  const field = useFieldContext();
  const content = resolveErrorContent(children, errors, field.error);
  // Gate rendering on the surrounding Field being marked invalid so the
  // control's aria-describedby (which only references errorId when invalid)
  // stays in sync with what's actually on screen.
  if (!content || !field.invalid) return null;

  return (
    <div
      {...props}
      role="alert"
      data-slot="field-error"
      id={id ?? field.errorId}
      className={cx(styles.error, className)}
    >
      {content}
    </div>
  );
}

export type FieldSeparatorProps = ComponentProps<'div'> & {
  children?: ReactNode;
};

export function FieldSeparator({
  children,
  className,
  ...props
}: FieldSeparatorProps) {
  return (
    <div
      data-slot="field-separator"
      data-content={children ? '' : undefined}
      className={cx(styles.separator, className)}
      {...props}
    >
      <span aria-hidden="true" className={styles.separatorLine} />
      {children ? (
        <span className={styles.separatorLabel}>{children}</span>
      ) : null}
    </div>
  );
}
