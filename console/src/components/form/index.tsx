import {
  type ComponentProps,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type UseFormDraftReturn,
  useFormDraft,
} from '../../hooks/use-form-draft';
import {
  type AnyFormController,
  FormContext,
  FormRegistryContext,
  type FormRegistryContextValue,
  FormSignalsContext,
  type FormSignalsContextValue,
  FormStateContext,
  type FormStateContextValue,
} from './context';

export {
  FormControl,
  type FormControlProps,
  FormDescription,
  FormItem,
  FormLabel,
  FormMessage,
} from './aliases';
export {
  type AnyFormController,
  type FormFieldContextValue,
  type FormRegistryContextValue,
  type FormSignalsContextValue,
  type FormStateContextValue,
  useFormContext,
  useFormFieldContext,
  useFormRegistry,
  useFormSignals,
  useFormState,
} from './context';
export {
  FormField,
  type FormFieldBinding,
  type FormFieldProps,
  type FormFieldRenderProps,
  type FormFieldState,
} from './form-field';

export type UseFormReturn = FormRegistryContextValue & {
  /** True iff no descendant Field is currently reporting an error. */
  isValid: boolean;
  /** Snapshot of every active error keyed by field id. */
  errors: ReadonlyMap<string, string>;
  /**
   * Run every registered validator synchronously and overlay results onto
   * the errors map. Returns the resulting map so callers can branch on it
   * without waiting for the next render. Used by `<Form>` on submit;
   * exposed for callers that want to validate-all imperatively.
   */
  validateAll: () => ReadonlyMap<string, string>;
  /**
   * Bump the reset counter, which clears `submitAttempted` and signals
   * every descendant Field to drop its internal touched/error state.
   * Typical use: call after a successful save so the next edit cycle
   * starts fresh.
   */
  reset: () => void;
  /**
   * Monotonic counter bumped by `reset()`. Surfaced for Field internals;
   * consumers rarely read this directly.
   */
  resetSeq: number;
  /**
   * Overlay externally-sourced errors (e.g. from a server response) onto
   * the form. Each `id` matches the Field's controlId; pass `null` to
   * clear a slot, or omit it. Mirrors into each Field's local error so
   * `<FieldError />` renders without callers switching to controlled mode.
   */
  setErrors: (errors: Record<string, string | null>) => void;
  /** Clear every Field's error and the form-level errors map. */
  clearErrors: () => void;
};

/**
 * Combined form controller that owns both the editable draft and the
 * error registry. Returned by `useForm({source})`. Adds the `useFormDraft`
 * surface (draft / setDraft / setField / isDirty / discard / commit)
 * onto the base errors-only API.
 */
export type UseFormControllerReturn<T> = UseFormReturn & UseFormDraftReturn<T>;

export type UseFormOptions<T> = {
  /** Server snapshot — typically `query.data`. May be undefined while loading. */
  source: T | undefined;
  /** Custom equality for `isDirty`. Defaults to a structural deep-equals. */
  equals?: (a: T, b: T) => boolean;
};

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
 *
 * Pass `{source}` to also own the draft state — the typical shadcn-style
 * "form holds everything" workflow:
 *
 *   const form = useForm({ source: query.data?.config });
 *   <FormField form={form} name="ops.port" required>
 *     {({field}) => <Input {...field} />}
 *   </FormField>
 */
export function useForm(): UseFormReturn;
export function useForm<T>(opts: UseFormOptions<T>): UseFormControllerReturn<T>;
export function useForm<T>(
  opts?: UseFormOptions<T>,
): UseFormReturn | UseFormControllerReturn<T> {
  const [errors, setErrorsState] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [resetSeq, setResetSeq] = useState(0);
  // Validators + per-Field setError callbacks live in refs so updates
  // don't tick the FormRegistryContext (which would re-render every Field
  // consumer).
  const validatorsRef = useRef<Map<string, () => string | null>>(new Map());
  const errorSettersRef = useRef<Map<string, (error: string | null) => void>>(
    new Map(),
  );
  const errorsRef = useRef(errors);
  errorsRef.current = errors;

  const registerError = useCallback((id: string, error: string | null) => {
    setErrorsState((prev) => {
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

  const registerValidator = useCallback(
    (id: string, validate: () => string | null) => {
      validatorsRef.current.set(id, validate);
      return () => {
        if (validatorsRef.current.get(id) === validate) {
          validatorsRef.current.delete(id);
        }
      };
    },
    [],
  );

  const registerErrorSetter = useCallback(
    (id: string, setError: (error: string | null) => void) => {
      errorSettersRef.current.set(id, setError);
      return () => {
        if (errorSettersRef.current.get(id) === setError) {
          errorSettersRef.current.delete(id);
        }
      };
    },
    [],
  );

  const validateAll = useCallback((): ReadonlyMap<string, string> => {
    // Overlay synchronous validator results onto the live errors snapshot.
    // We write back through registerError so the registry tracks reality,
    // but the returned map already reflects the merged state — callers
    // (like handleSubmit) can branch immediately without waiting for the
    // setErrors batch to flush.
    const merged = new Map(errorsRef.current);
    for (const [id, validate] of validatorsRef.current) {
      const result = validate();
      if (result === null) merged.delete(id);
      else merged.set(id, result);
      registerError(id, result);
    }
    return merged;
  }, [registerError]);

  const setErrors = useCallback(
    (incoming: Record<string, string | null>) => {
      for (const [id, error] of Object.entries(incoming)) {
        const setter = errorSettersRef.current.get(id);
        // The setter (when registered) already calls registerError on
        // our behalf, so we don't need a separate registerError call
        // when a matching Field is mounted.
        if (setter) setter(error);
        else registerError(id, error);
      }
    },
    [registerError],
  );

  const clearErrors = useCallback(() => {
    for (const setter of errorSettersRef.current.values()) setter(null);
    setErrorsState((prev) => (prev.size === 0 ? prev : new Map()));
  }, []);

  const reset = useCallback(() => {
    setErrorsState((prev) => (prev.size === 0 ? prev : new Map()));
    setResetSeq((seq) => seq + 1);
  }, []);

  const baseReturn: UseFormReturn = useMemo(
    () => ({
      registerError,
      registerValidator,
      registerErrorSetter,
      validateAll,
      setErrors,
      clearErrors,
      reset,
      resetSeq,
      errors,
      isValid: errors.size === 0,
    }),
    [
      registerError,
      registerValidator,
      registerErrorSetter,
      validateAll,
      setErrors,
      clearErrors,
      reset,
      resetSeq,
      errors,
    ],
  );

  // Hooks must run unconditionally — when no `source` is passed, useFormDraft
  // is still called with `undefined` and stays inert (draft stays `null`).
  // The returned bag is discarded for the legacy errors-only mode.
  const draft = useFormDraft<T>({
    source: opts?.source,
    equals: opts?.equals,
  });

  if (!opts) return baseReturn;
  return { ...baseReturn, ...draft };
}

export type FormProps = Omit<ComponentProps<'form'>, 'onSubmit'> & {
  form: UseFormReturn;
  /**
   * Called when the form is submitted (Enter inside a control, or a
   * `<button type="submit">` click). The default-prevented submit event
   * is consumed automatically. Receives no arguments — caller already
   * holds the draft they want to save. May return a Promise; while the
   * Promise is in flight, `isSubmitting` is `true` on `FormSignalsContext`
   * and repeated submits are ignored.
   */
  onSubmit?: () => void | Promise<void>;
  children: ReactNode;
};

export function Form({
  form,
  onSubmit,
  children,
  noValidate = true,
  ...formProps
}: FormProps) {
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Read the latest validateAll / onSubmit via refs so handleSubmit's
  // identity stays stable across error ticks — re-creating the handler
  // on every keystroke would force every <form> consumer to re-render.
  const validateAllRef = useRef(form.validateAll);
  validateAllRef.current = form.validateAll;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  // Track in-flight submits via a ref so handleSubmit can short-circuit
  // synchronously even if the corresponding state update hasn't landed.
  const isSubmittingRef = useRef(false);

  // form.reset() bumps resetSeq; clear submitAttempted to mirror.
  const prevResetSeq = useRef(form.resetSeq);
  if (prevResetSeq.current !== form.resetSeq) {
    prevResetSeq.current = form.resetSeq;
    if (submitAttempted) setSubmitAttempted(false);
  }

  const handleSubmit = useCallback((event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    setSubmitAttempted(true);
    // Run any consumer-supplied validators synchronously so untouched
    // required fields surface their errors before we decide whether to
    // call onSubmit. validateAll() also writes the results back into
    // the registry, so visible state catches up on the next render.
    const merged = validateAllRef.current();
    if (merged.size > 0) {
      const firstId = firstErrorIdInDocumentOrder(merged);
      if (firstId) {
        const target = document.getElementById(firstId);
        if (target && typeof target.focus === 'function') target.focus();
      }
      return;
    }
    const result = onSubmitRef.current?.();
    if (!isPromiseLike(result)) return;
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    const settle = () => {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    };
    result.then(settle, settle);
  }, []);

  // Stable registry context — only the function references matter here, so
  // Fields that subscribe via useFormRegistry() don't re-render when the
  // error map ticks (only consumers of FormStateContext do).
  const registry = useMemo<FormRegistryContextValue>(
    () => ({
      registerError: form.registerError,
      registerValidator: form.registerValidator,
      registerErrorSetter: form.registerErrorSetter,
    }),
    [form.registerError, form.registerValidator, form.registerErrorSetter],
  );
  const state = useMemo<FormStateContextValue>(
    () => ({
      isValid: form.isValid,
      errors: form.errors,
    }),
    [form.isValid, form.errors],
  );
  // Sparse signals — Fields subscribe here, so they don't re-render every
  // time a sibling Field's error ticks (which would happen if we put
  // submitAttempted on the same context as `errors`).
  const signals = useMemo<FormSignalsContextValue>(
    () => ({ submitAttempted, resetSeq: form.resetSeq, isSubmitting }),
    [submitAttempted, form.resetSeq, isSubmitting],
  );
  // Expose the form bundle for descendant <FormField>s so callers don't
  // have to thread `form={form}` through every binding. This context's
  // value identity ticks on every draft change — that's intentional, the
  // FormFields downstream need a fresh value to render. Other contexts
  // (state/signals/registry) stay stable across error ticks for
  // re-render isolation.
  const formCtx = useMemo<AnyFormController | null>(() => {
    if (!('setField' in form && 'draft' in form)) return null;
    const controller = form as UseFormControllerReturn<unknown>;
    return { draft: controller.draft, setField: controller.setField };
  }, [form]);

  return (
    <FormContext.Provider value={formCtx}>
      <FormRegistryContext.Provider value={registry}>
        <FormStateContext.Provider value={state}>
          <FormSignalsContext.Provider value={signals}>
            <form
              noValidate={noValidate}
              {...formProps}
              onSubmit={handleSubmit}
            >
              {children}
            </form>
          </FormSignalsContext.Provider>
        </FormStateContext.Provider>
      </FormRegistryContext.Provider>
    </FormContext.Provider>
  );
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function firstErrorIdInDocumentOrder(
  errors: ReadonlyMap<string, string>,
): string | undefined {
  if (errors.size === 0) return undefined;
  if (typeof document === 'undefined') return errors.keys().next().value;
  let earliest: { id: string; el: HTMLElement } | null = null;
  for (const id of errors.keys()) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (
      earliest === null ||
      (earliest.el.compareDocumentPosition(el) &
        Node.DOCUMENT_POSITION_PRECEDING) !==
        0
    ) {
      // `el` precedes `earliest.el`, or earliest is unset.
      earliest = { id, el };
    }
  }
  return earliest?.id ?? errors.keys().next().value;
}
