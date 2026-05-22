import { createContext, useContext } from 'react';

export type FieldContextValue = {
  id: string | undefined;
  descriptionId: string | undefined;
  errorId: string | undefined;
  invalid: boolean | undefined;
  disabled: boolean | undefined;
  /**
   * When `true`, descendant controls emit `aria-required="true"`. Field
   * derives this from its `required` prop, which `<FormField required>`
   * forwards down so the visual + assistive layers stay in sync.
   */
  required: boolean | undefined;
  /**
   * The current error message for this field, or `null` if valid.
   * Controls write here via `setError`; `<FieldError />` reads it.
   */
  error: string | null;
  /**
   * Set or clear the field-level error. Calling with the same value as
   * `error` is a no-op for downstream subscribers.
   */
  setError: (error: string | null) => void;
  /**
   * `true` once the user has blurred any descendant control of this Field.
   * Used by `<FieldError />` to suppress messages on freshly-mounted forms.
   * A surrounding `<Form>` can also force-reveal errors on submit attempt
   * (see `useFormState().submitAttempted`).
   */
  touched: boolean;
  /** Mark this field touched. Called by Field's onBlur listener. */
  setTouched: (touched: boolean) => void;
};

const defaultValue: FieldContextValue = {
  id: undefined,
  descriptionId: undefined,
  errorId: undefined,
  invalid: undefined,
  disabled: undefined,
  required: undefined,
  error: null,
  setError: () => {},
  touched: false,
  setTouched: () => {},
};

export const FieldContext = createContext<FieldContextValue>(defaultValue);

export function useFieldContext(): FieldContextValue {
  return useContext(FieldContext);
}

type FieldControlProps = {
  id?: string;
  disabled?: boolean;
  required?: boolean;
  'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling';
  'aria-required'?: boolean | 'true' | 'false';
  'aria-describedby'?: string;
};

/**
 * Merge field-context defaults into a control's props. Consumer-provided
 * values always win — context only fills gaps.
 */
export function useFieldControlProps<P extends FieldControlProps>(props: P): P {
  const field = useFieldContext();
  const describedBy = mergeIds(
    field.descriptionId,
    field.invalid ? field.errorId : undefined,
    props['aria-describedby'],
  );
  return {
    ...props,
    id: props.id ?? field.id,
    disabled: props.disabled ?? field.disabled,
    required: props.required ?? field.required,
    'aria-invalid': props['aria-invalid'] ?? field.invalid,
    'aria-required':
      props['aria-required'] ?? (field.required ? true : undefined),
    'aria-describedby': describedBy,
  };
}

export function mergeIds(
  ...ids: Array<string | undefined>
): string | undefined {
  const filtered = ids.filter((id): id is string => Boolean(id));
  return filtered.length === 0 ? undefined : filtered.join(' ');
}
