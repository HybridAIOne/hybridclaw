import {
  type ComponentProps,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useMemo,
  useState,
} from 'react';
import {
  FormRegistryContext,
  type FormRegistryContextValue,
  FormStateContext,
  type FormStateContextValue,
} from './context';

export {
  type FormRegistryContextValue,
  type FormStateContextValue,
  useFormRegistry,
  useFormState,
} from './context';

export type UseFormReturn = FormRegistryContextValue & FormStateContextValue;

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
  noValidate = true,
  ...formProps
}: FormProps) {
  const handleSubmit = useCallback(
    (event: SyntheticEvent<HTMLFormElement>) => {
      event.preventDefault();
      onSubmit?.();
    },
    [onSubmit],
  );

  // Stable registry context — only `registerError` reference matters here,
  // so Fields that subscribe via useFormRegistry() don't re-render when
  // the error map ticks (only consumers of FormStateContext do).
  const registry = useMemo<FormRegistryContextValue>(
    () => ({ registerError: form.registerError }),
    [form.registerError],
  );
  const state = useMemo<FormStateContextValue>(
    () => ({ isValid: form.isValid, errors: form.errors }),
    [form.isValid, form.errors],
  );

  return (
    <FormRegistryContext.Provider value={registry}>
      <FormStateContext.Provider value={state}>
        <form noValidate={noValidate} {...formProps} onSubmit={handleSubmit}>
          {children}
        </form>
      </FormStateContext.Provider>
    </FormRegistryContext.Provider>
  );
}
