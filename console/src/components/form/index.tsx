import {
  type ComponentProps,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useMemo,
  useState,
} from 'react';
import { FormContext, type FormContextValue } from './context';

export { useFormContext as useFormState } from './context';
export type { FormContextValue } from './context';

export type UseFormReturn = FormContextValue;

/**
 * Tracks form-level validity by aggregating errors from any descendant
 * Field. Each Field calls `registerError(id, message)` when its error
 * channel changes; the hook keeps a Map of active errors and exposes
 * `isValid` for save-button gating.
 *
 *   const form = useForm();
 *   <Form form={form} onSubmit={() => save.mutate(draft)}>
 *     <Field>…</Field>
 *     <Button type="submit" disabled={!form.isValid}>Save</Button>
 *   </Form>
 */
export function useForm(): UseFormReturn {
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map());

  const registerError = useCallback((id: string, error: string | null) => {
    setErrors((prev) => {
      if (error === null) {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      }
      if (prev.get(id) === error) return prev;
      const next = new Map(prev);
      next.set(id, error);
      return next;
    });
  }, []);

  return useMemo(
    () => ({
      registerError,
      errors,
      isValid: errors.size === 0,
    }),
    [registerError, errors],
  );
}

export type FormProps = Omit<ComponentProps<'form'>, 'onSubmit'> & {
  form: UseFormReturn;
  /**
   * Called when the form is submitted (Enter inside a control, or a
   * `<button type="submit">` click). The default-prevented submit event
   * is consumed automatically. Receives no arguments — caller already
   * holds the draft they want to save.
   */
  onSubmit?: () => void;
  children: ReactNode;
};

export function Form({
  form,
  onSubmit,
  children,
  ...formProps
}: FormProps) {
  const handleSubmit = useCallback(
    (event: SyntheticEvent<HTMLFormElement>) => {
      event.preventDefault();
      onSubmit?.();
    },
    [onSubmit],
  );

  return (
    <FormContext.Provider value={form}>
      <form noValidate {...formProps} onSubmit={handleSubmit}>
        {children}
      </form>
    </FormContext.Provider>
  );
}

