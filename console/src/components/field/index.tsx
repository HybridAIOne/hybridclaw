import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cx } from '../../lib/cx';
import { useStableCallback } from '../../lib/use-stable-callback';
import {
  useFormFieldContext,
  useFormRegistry,
  useFormSignals,
} from '../form/context';
import { Label } from '../label';
import { FieldContext, useFieldContext } from './context';
import styles from './field.module.css';

export type { FieldContextValue } from './context';
export { mergeIds, useFieldContext, useFieldControlProps } from './context';
export { validateField } from './validate-field';
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
   * Forwarded as `aria-required="true"` to every descendant control via
   * `useFieldControlProps`. `<FormField required>` sets this automatically.
   */
  required?: boolean;
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
   * `validateField` result onto a Field that wraps a raw `<Input>`.
   */
  error?: string | null;
  /**
   * Force the field's touched state. When omitted, Field flips touched
   * to true on the first blur of any descendant control. Set to `true`
   * to force errors visible from mount, or pin to `false` to suppress
   * blur-triggered touching (rare).
   */
  touched?: boolean;
  /**
   * Called by Field when the surrounding `<Form>` records a submit
   * attempt. Returning a non-null string registers a field-level error
   * even for fields the user never edited, closing the
   * "untouched required field passes submit" gap. Identity-stable —
   * wrap in `useCallback` if the closure depends on draft state.
   */
  validate?: () => string | null;
};

export function Field({
  className,
  orientation = 'vertical',
  invalid,
  disabled: disabledProp,
  required: requiredProp,
  controlId,
  onErrorChange,
  error: errorProp,
  touched: touchedProp,
  validate: validateProp,
  onBlur,
  ...props
}: FieldProps) {
  // Auto-wire when nested under a `<FormField>` — match its generated id
  // (so FieldLabel.htmlFor + Input.id agree), forward its required and
  // disabled flags, hand its validate() to Form's submit registry, and
  // read its rules-computed error as a fallback below.
  const formField = useFormFieldContext();
  const generatedId = useId();
  const id = controlId ?? formField?.id ?? generatedId;
  const required = requiredProp ?? formField?.required;
  const disabled = disabledProp ?? formField?.disabled;
  const validate = validateProp ?? formField?.validate;
  const [internalError, setErrorState] = useState<string | null>(null);
  const [internalTouched, setInternalTouched] = useState(false);
  const reportError = useStableCallback(onErrorChange ?? noop);
  const isControlled = errorProp !== undefined;
  const touched = touchedProp ?? internalTouched;

  // In controlled mode the parent owns the error string; ignore writes
  // from descendant controls so we don't carry dead internal state.
  const setError = useCallback(
    (next: string | null) => {
      if (isControlled) return;
      setErrorState((current) => (current === next ? current : next));
    },
    [isControlled],
  );

  // Resolution order: an explicit `error` prop (controlled) > a descendant
  // control's setError write (e.g. NumberField's bounds message) >
  // FormFieldContext's rules-computed error. The descendant path comes
  // first because it represents the most recent user input; the FormField
  // path is the declarative default and acts as a fallback when no
  // descendant has written anything.
  const error = isControlled
    ? errorProp
    : (internalError ?? formField?.error ?? null);

  // When nested in a <Form>, report errors up so the form-level
  // useForm().isValid selector stays in sync. The registry context is
  // identity-stable across renders, so this effect only re-runs when
  // `id` or `error` actually changes — no register/clear loop.
  const registry = useFormRegistry();
  useEffect(() => {
    if (registry) registry.registerError(id, error);
  }, [registry, id, error]);

  // Cleanup is split from the registration effect so the slot transitions
  // directly between non-null error strings without an intermediate
  // null-clear that would tick form-level subscribers an extra time.
  // Deps capture the registry/id used at mount; clears that exact slot
  // when those change or on unmount.
  useEffect(() => {
    if (!registry) return;
    return () => registry.registerError(id, null);
  }, [registry, id]);

  // Expose our setError so `form.setErrors(...)` can push server-side
  // errors directly into this Field's local state. The [registry, id,
  // error] effect above already syncs the form's errors map whenever
  // setError ticks internalError, so we don't double-write here. An
  // externally-pushed error is treated as touched-equivalent so the
  // message is visible immediately — callers reach for setErrors when
  // they have already decided the user needs to see something.
  useEffect(() => {
    if (!registry || isControlled) return;
    return registry.registerErrorSetter(id, (next) => {
      if (next !== null) setInternalTouched(true);
      setError(next);
    });
  }, [registry, id, isControlled, setError]);

  useEffect(() => {
    reportError(error);
  }, [error, reportError]);

  // A surrounding <Form> can force errors visible once the user attempts
  // submission, and bump resetSeq to clear touched/error after save.
  // Outside a Form, signals stays null.
  const signals = useFormSignals();
  const submitAttempted = signals?.submitAttempted ?? false;
  const resetSeq = signals?.resetSeq ?? 0;

  // form.reset() — clear internal touched/error so the next edit cycle
  // doesn't inherit stale visibility from a prior submit.
  const prevResetSeq = useRef(resetSeq);
  if (prevResetSeq.current !== resetSeq) {
    prevResetSeq.current = resetSeq;
    setInternalTouched(false);
    setErrorState(null);
  }

  // Register the consumer's validator with the form so it can be called
  // synchronously on submit — closing the "untouched required field
  // passes submit-time validation" gap. The wrapper mirrors the result
  // into local Field state so <FieldError/> can pick it up alongside
  // the form-level errors map. Wrapped via useStableCallback so the
  // registry entry doesn't churn when `validate` is an inline closure.
  const validateLatest = useStableCallback(validate ?? noopValidate);
  useEffect(() => {
    if (validate === undefined || !registry) return;
    return registry.registerValidator(id, () => {
      const result = validateLatest();
      setError(result);
      return result;
    });
  }, [registry, id, validate, validateLatest, setError]);
  // Bypass the touched gate when the caller has explicitly opted in by
  // either passing `invalid` or controlling `error` — they've already
  // decided to surface the message (e.g. a server-side validation
  // result piped through). The internal, descendant-driven path is
  // gated so unblurred required fields don't announce "invalid" before
  // the user has had a chance to type.
  let exposedInvalid: boolean | undefined;
  if (invalid !== undefined) {
    exposedInvalid = invalid;
  } else if ((isControlled || touched || submitAttempted) && error !== null) {
    exposedInvalid = true;
  } else {
    exposedInvalid = undefined;
  }

  const ctx = useMemo(
    () => ({
      id,
      labelId: `${id}-label`,
      descriptionId: `${id}-description`,
      errorId: `${id}-error`,
      invalid: exposedInvalid,
      disabled,
      required,
      error,
      setError,
      touched,
      setTouched: setInternalTouched,
    }),
    [id, exposedInvalid, disabled, required, error, setError, touched],
  );

  // React onBlur is delegated to native focusout, which bubbles — any
  // descendant control's blur is observed here. Idempotent: setInternalTouched
  // only ticks state on the first true.
  const handleBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    setInternalTouched(true);
    onBlur?.(event);
  };

  // Native `input` and `change` events bubble out of form controls, so we
  // can centralise "user has interacted with this field" detection on the
  // wrapper. `input` fires on every keystroke; `change` fires for selects,
  // radios, and native checkboxes that don't emit `input`.
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const touch = () => setInternalTouched(true);
    el.addEventListener('input', touch);
    el.addEventListener('change', touch);
    return () => {
      el.removeEventListener('input', touch);
      el.removeEventListener('change', touch);
    };
  }, []);

  return (
    <FieldContext.Provider value={ctx}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: this div is a layout container; the onBlur listens for bubbled focusout from descendant controls to drive touched-detection, not direct interactivity. */}
      <div
        ref={wrapperRef}
        data-slot="field"
        data-orientation={orientation}
        data-invalid={exposedInvalid || undefined}
        data-disabled={disabled || undefined}
        className={cx(styles.field, orientationClass[orientation], className)}
        onBlur={handleBlur}
        {...props}
      />
    </FieldContext.Provider>
  );
}

function noop(): void {}
function noopValidate(): null {
  return null;
}

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

export function FieldLabel({
  className,
  htmlFor,
  id,
  ...props
}: FieldLabelProps) {
  const field = useFieldContext();
  return (
    <Label
      data-slot="field-label"
      id={id ?? field.labelId}
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
    ].filter((error): error is { message?: string } => Boolean(error?.message));

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
