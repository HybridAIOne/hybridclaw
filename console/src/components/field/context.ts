import { createContext, useContext } from 'react';

export type FieldContextValue = {
  id: string | undefined;
  descriptionId: string | undefined;
  errorId: string | undefined;
  invalid: boolean | undefined;
  disabled: boolean | undefined;
};

const defaultValue: FieldContextValue = {
  id: undefined,
  descriptionId: undefined,
  errorId: undefined,
  invalid: undefined,
  disabled: undefined,
};

export const FieldContext = createContext<FieldContextValue>(defaultValue);

export function useFieldContext(): FieldContextValue {
  return useContext(FieldContext);
}

type FieldControlProps = {
  id?: string;
  disabled?: boolean;
  'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling';
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
    'aria-invalid': props['aria-invalid'] ?? field.invalid,
    'aria-describedby': describedBy,
  };
}

function mergeIds(...ids: Array<string | undefined>): string | undefined {
  const filtered = ids.filter((id): id is string => Boolean(id));
  return filtered.length === 0 ? undefined : filtered.join(' ');
}
