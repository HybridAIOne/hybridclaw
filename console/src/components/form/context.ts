import { createContext, useContext } from 'react';

export type FormRegistryContextValue = {
  /**
   * Called by Field whenever its displayed error changes. The `id` is the
   * field's controlId (or auto-generated id) — stable across the lifetime
   * of the Field instance. Stable identity across renders so consuming
   * Fields don't re-render when the form's error map ticks.
   */
  registerError: (id: string, error: string | null) => void;
};

export type FormStateContextValue = {
  /** True iff no descendant Field is currently reporting an error. */
  isValid: boolean;
  /** Snapshot of every active error keyed by field id. */
  errors: ReadonlyMap<string, string>;
};

/**
 * Registry context — held identity-stable across renders so 88 Fields on a
 * page don't all re-render when one field's error ticks. Fields only read
 * `registerError`; they never need to see the aggregate `errors` map.
 */
export const FormRegistryContext =
  createContext<FormRegistryContextValue | null>(null);

/**
 * State context — re-evaluates on every error change. Consumed by save
 * buttons, summaries, anything that needs `isValid` to gate UI.
 */
export const FormStateContext = createContext<FormStateContextValue | null>(
  null,
);

export function useFormRegistry(): FormRegistryContextValue | null {
  return useContext(FormRegistryContext);
}

export function useFormState(): FormStateContextValue | null {
  return useContext(FormStateContext);
}
