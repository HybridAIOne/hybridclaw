import { type ReactNode, useCallback, useId, useMemo } from 'react';
import { getPath } from '../../lib/object-path';
import type { Validator } from '../field/validators';
import { compose, required as requiredValidator } from '../field/validators';
import { FormFieldContext, useFormContext } from './context';
import type { UseFormControllerReturn } from './index';

/**
 * The binding object handed to FormField's render prop. Designed to spread
 * onto event-shape primitives (Input, Textarea, NativeSelect) — onChange
 * understands change events and pulls `.target.value` (or `.target.checked`
 * for `<input type="checkbox">`). It also passes raw values through
 * unchanged, so value-shape primitives can wire up directly:
 *
 *   <Input {...field} />
 *   <Switch checked={field.value} onCheckedChange={field.onChange} />
 *   <NumberField value={field.value} onValueChange={field.onChange} />
 *
 * `value` is typed `any` (escape hatch); narrow at the call site if
 * useful. This mirrors react-hook-form's `field` shape — keeping the
 * type loose at this boundary avoids forcing every consumer through a
 * heavyweight dotted-path resolver.
 */
export type FormFieldBinding = {
  /** Dotted path the binding was created for. */
  name: string;
  /** Current value at `name` in the form's draft. Typed loose on purpose. */
  // biome-ignore lint/suspicious/noExplicitAny: see doc-comment.
  value: any;
  /** Stable DOM id matching the surrounding Field's controlId. */
  id: string;
  /**
   * Event-aware setter. Accepts a `ChangeEvent` (extracts the right
   * `target.value` / `target.checked`) or a raw value. Writes through
   * `form.setField(name, ...)`.
   */
  onChange: (eventOrValue: unknown) => void;
  /** `true` when the FormField is marked `required` — for direct spread. */
  'aria-required'?: true;
  /** `disabled` mirror so simple controls can pick it up via spread. */
  disabled?: boolean;
};

export type FormFieldState = {
  /** Current validation error, or `null` when valid. */
  error: string | null;
  /** Convenience boolean — `error !== null`. */
  invalid: boolean;
};

export type FormFieldRenderProps = {
  field: FormFieldBinding;
  fieldState: FormFieldState;
};

export type FormFieldProps<TDraft = unknown, V = unknown> = {
  /**
   * Combined controller from `useForm({source})`. Optional — when omitted,
   * pulled from the surrounding `<Form>`'s `FormContext`. Pass explicitly
   * only when you need to bind a FormField outside any `<Form>`.
   */
  form?: UseFormControllerReturn<TDraft>;
  /** Dotted path into `form.draft` (e.g. `'ops.healthPort'`). */
  name: string;
  /**
   * Validation rules. Composed once per `[required, rules]` array identity,
   * but the resulting validator runs on every render of this FormField —
   * so each rule must be pure and cheap. Avoid network calls or O(n) work
   * over large strings; surface anything heavier through a dedicated
   * onBlur path or a debounced effect instead.
   */
  rules?: ReadonlyArray<Validator<V> | undefined | false | null>;
  /**
   * When `true`, auto-prepends a `required()` validator and propagates
   * `aria-required` through `<Field>` to every descendant control.
   */
  required?: boolean;
  /** Disabled state — flows into `field.disabled` for spread. */
  disabled?: boolean;
  /**
   * shadcn-style render prop. Receives `{field, fieldState}`. Equivalent
   * to passing a function as `children`; either form works.
   */
  render?: (props: FormFieldRenderProps) => ReactNode;
  /**
   * Function-as-children alternative to `render`. If both are provided,
   * `render` wins.
   */
  children?: ReactNode | ((props: FormFieldRenderProps) => ReactNode);
};

/**
 * Binds a single field of `form.draft` to its rendered controls. Mirrors
 * react-hook-form / shadcn's `<FormField>`: a render-prop wrapper that
 * pumps value + onChange into a render function and lets the consumer
 * compose the layout themselves.
 *
 *   <Form form={form}>
 *     <FormField name="email" required rules={[email()]} render={({field}) => (
 *       <Field>
 *         <FieldLabel>Email</FieldLabel>
 *         <Input {...field} />
 *         <FieldDescription>...</FieldDescription>
 *         <FieldError />
 *       </Field>
 *     )} />
 *   </Form>
 *
 * The descendant `<Field>` reads the binding from `FormFieldContext` and
 * auto-wires controlId, validate, required, and pipes the rules-computed
 * error through Field's internal error state so touched-gating still
 * applies.
 */
export function FormField<TDraft = unknown, V = unknown>(
  props: FormFieldProps<TDraft, V>,
): ReactNode {
  const {
    form: formProp,
    name,
    rules,
    required,
    disabled,
    render,
    children,
  } = props;
  const formCtx = useFormContext();
  const form = (formProp ?? formCtx) as UseFormControllerReturn<TDraft> | null;
  if (!form) {
    throw new Error(
      'FormField requires either a `form` prop or to be nested inside <Form>.',
    );
  }

  const generatedId = useId();

  // Merge auto-required with caller rules. Memoised so the array identity
  // only changes when the actual inputs do — keeps downstream effects
  // (validate, error) from re-running on every render.
  // Merge auto-required with caller rules into a single composed validator
  // — memoised so the closure identity only changes when `required`/`rules`
  // do, keeping the per-render error compute and the captured `validate`
  // callback cheap across many FormFields.
  const runValidators = useMemo<Validator<V>>(() => {
    const list: Validator<V>[] = [];
    if (required) list.push(requiredValidator<V>());
    if (rules) {
      for (const rule of rules) {
        if (typeof rule === 'function') list.push(rule);
      }
    }
    return compose<V>(...list);
  }, [required, rules]);

  const value = getPath<V>(form.draft, name) as V;
  const error = runValidators(value);

  const onChange = useCallback(
    (arg: unknown) => {
      form.setField(name, extractEventValue(arg));
    },
    [form, name],
  );

  // `validate` is what Form.handleSubmit invokes; pulls a fresh value
  // straight out of the draft (rather than the closure-captured one) so
  // a submit immediately after editing still sees the latest text.
  const validate = useCallback(() => {
    const live = getPath<V>(form.draft, name) as V;
    return runValidators(live);
  }, [form, name, runValidators]);

  const field = useMemo<FormFieldBinding>(
    () => ({
      name,
      value,
      id: generatedId,
      onChange,
      'aria-required': required ? true : undefined,
      disabled,
    }),
    [name, value, generatedId, onChange, required, disabled],
  );

  const fieldState = useMemo<FormFieldState>(
    () => ({ error, invalid: error !== null }),
    [error],
  );

  // Snapshot the binding for any descendant Field that wants to auto-wire.
  const ctx = useMemo(
    () => ({
      name,
      id: generatedId,
      error,
      validate,
      required,
      disabled,
    }),
    [name, generatedId, error, validate, required, disabled],
  );

  const content =
    render?.({ field, fieldState }) ??
    (typeof children === 'function'
      ? children({ field, fieldState })
      : children);

  return (
    <FormFieldContext.Provider value={ctx}>{content}</FormFieldContext.Provider>
  );
}

/**
 * Pull the meaningful value out of a change event, falling back to the
 * raw argument for callers that pass non-event values directly (Switch's
 * `onCheckedChange(boolean)`, NumberField's `onValueChange(number)`,
 * Combobox's `onValueChange(value, option)`, etc.).
 */
function extractEventValue(arg: unknown): unknown {
  if (arg === null || typeof arg !== 'object') return arg;
  const maybeEvent = arg as { target?: unknown };
  if (!maybeEvent.target || typeof maybeEvent.target !== 'object') {
    return arg;
  }
  const target = maybeEvent.target as {
    type?: string;
    value?: unknown;
    checked?: unknown;
  };
  if (target.type === 'checkbox') {
    return target.checked ?? false;
  }
  // A native radio's meaningful value is its `value`, not `checked` (which is
  // simply `true` for the selected input) — fall through to the value branch.
  if ('value' in target) return target.value;
  return arg;
}
