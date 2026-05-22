import { createContext, useContext } from 'react';

export type FormContextValue = {
  /**
   * Called by Field whenever its displayed error changes. The `id` is the
   * field's controlId (or auto-generated id) — stable across the lifetime
   * of the Field instance.
   */
  registerError: (id: string, error: string | null) => void;
  /** True iff no descendant Field is currently reporting an error. */
  isValid: boolean;
  /** Snapshot of every active error keyed by field id. */
  errors: ReadonlyMap<string, string>;
};

export const FormContext = createContext<FormContextValue | null>(null);

export function useFormContext(): FormContextValue | null {
  return useContext(FormContext);
}
