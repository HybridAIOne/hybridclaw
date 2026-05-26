import { createContext, useContext } from 'react';
import type { Validator } from '../field/validators';

/**
 * The form bundle exposed to `<FormField>` (and any deeper consumer that
 * wants form.draft / setField). Pulled from `<Form>` via `FormContext`.
 * Typed loose at this boundary so the context can hold any draft shape;
 * `<FormField>` re-narrows via its own generics at the spread site.
 */
export type AnyFormController = {
  // Just the surface FormField touches; the full controller has more.
  // Typed `unknown` on purpose — consumers narrow via getPath generics.
  draft: unknown;
  setField: (path: string, value: unknown) => void;
};

export const FormContext = createContext<AnyFormController | null>(null);

export function useFormContext(): AnyFormController | null {
  return useContext(FormContext);
}

/**
 * Set by `<FormField>` on its render-prop subtree so a nested `<Field>`
 * can pick up the binding without explicit prop drilling. Field reads:
 *  - `id`   → controlId override (so FieldLabel.htmlFor + Input.id agree)
 *  - `error`/`validate` → piped into Field's internal error machinery
 *  - `required` → propagates `aria-required` to descendant controls.
 */
export type FormFieldContextValue = {
  name: string;
  id: string;
  error: string | null;
  validate: () => string | null;
  required: boolean | undefined;
  disabled: boolean | undefined;
};

export const FormFieldContext = createContext<FormFieldContextValue | null>(
  null,
);

export function useFormFieldContext(): FormFieldContextValue | null {
  return useContext(FormFieldContext);
}

export type FormRegistryContextValue = {
  /**
   * Called by Field whenever its displayed error changes. The `id` is the
   * field's controlId (or auto-generated id) — stable across the lifetime
   * of the Field instance. Stable identity across renders so consuming
   * Fields don't re-render when the form's error map ticks.
   */
  registerError: (id: string, error: string | null) => void;
  /**
   * Subscribe a synchronous validate callback for `id`. Called by `<Form>`
   * during submit handling so untouched fields still get a chance to
   * register an error. Returns an unsubscribe; `useEffect` cleanup pairs
   * naturally. Stable identity.
   */
  registerValidator: (id: string, validate: () => string | null) => () => void;
  /**
   * Subscribe a `setError` callback for `id`. Used by `form.setErrors()` to
   * push externally-sourced errors (typically from a server response) into
   * each matching Field's local state, so `<FieldError />` renders them
   * without consumers having to switch every Field to controlled mode.
   * Returns an unsubscribe. Stable identity.
   */
  registerErrorSetter: (
    id: string,
    setError: (error: string | null) => void,
  ) => () => void;
};

export type FormStateContextValue = {
  /** True iff no descendant Field is currently reporting an error. */
  isValid: boolean;
  /** Snapshot of every active error keyed by field id. */
  errors: ReadonlyMap<string, string>;
};

/**
 * Sparse "signal" context — only changes on submit attempts, async submit
 * lifecycle, and explicit resets, not on every error tick. Field components
 * subscribe here for the pieces they need to drive touched/error visibility
 * without re-rendering on every keystroke into a sibling field.
 */
export type FormSignalsContextValue = {
  /**
   * Set to `true` the first time `<Form>` receives a submit event; cleared
   * back to `false` when `form.reset()` runs. `<FieldError />` treats this
   * as a global "force visible" signal so untouched fields still surface
   * their errors when the user attempts to submit.
   */
  submitAttempted: boolean;
  /**
   * Monotonically incrementing counter bumped by `form.reset()`. Fields
   * watch this to clear their internal touched/error state when the form
   * is reset (typically after a successful save).
   */
  resetSeq: number;
  /**
   * `true` while `<Form>` is awaiting an async `onSubmit`. Save buttons
   * read this to disable themselves and show progress. Repeated submit
   * events are dropped while this is `true`.
   */
  isSubmitting: boolean;
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

/**
 * Signals context — only ticks on submit attempts and resets. Consumed by
 * Fields, which need `submitAttempted` and `resetSeq` but should not
 * re-render on every error change.
 */
export const FormSignalsContext = createContext<FormSignalsContextValue | null>(
  null,
);

export function useFormRegistry(): FormRegistryContextValue | null {
  return useContext(FormRegistryContext);
}

export function useFormState(): FormStateContextValue | null {
  return useContext(FormStateContext);
}

export function useFormSignals(): FormSignalsContextValue | null {
  return useContext(FormSignalsContext);
}

// Re-export Validator so the FormField type can reference it from one place.
export type { Validator };
