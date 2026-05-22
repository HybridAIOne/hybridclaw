import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { deepEquals } from '../lib/deep-equals';
import { setPath } from '../lib/object-path';

export type UseFormDraftOptions<T> = {
  /**
   * The server's current value — typically `query.data`. May be `undefined`
   * while the query is loading.
   */
  source: T | undefined;
  /**
   * Custom equality function for `isDirty`. Defaults to `deepEquals`,
   * which handles plain JSON shapes plus `Date` values without the
   * pitfalls of a `JSON.stringify`-based comparison (key order,
   * `undefined` keys, NaN, etc.).
   */
  equals?: (a: T, b: T) => boolean;
};

export type UseFormDraftReturn<T> = {
  /** Local edit buffer. `null` until the source becomes available. */
  draft: T | null;
  setDraft: Dispatch<SetStateAction<T | null>>;
  /**
   * Replace the value at a dotted path (e.g. `'ops.healthPort'`).
   * Equivalent to `setDraft(d => d ? structuralUpdate(d, path, value) : d)`.
   * No-op if `draft` is null.
   */
  setField: (path: string, value: unknown) => void;
  /** True iff `draft` differs from `source` under the configured equality. */
  isDirty: boolean;
  /** Replace `draft` with the current `source` value. */
  discard: () => void;
  /** Replace `draft` with the value the server just confirmed. */
  commit: (value: T) => void;
};

/**
 * The canonical "query → draft → dirty → save/discard" cycle.
 *
 * Hydrates `draft` once `source` is non-undefined; tracks dirtiness via a
 * pluggable equality function; exposes `discard` (revert to source) and
 * `commit` (replace draft after a successful save).
 *
 * Designed to pair with a mutation hook (e.g. `useFormMutation`):
 *
 *   const { draft, setDraft, isDirty, discard, commit } =
 *     useFormDraft({ source: query.data });
 *   const save = useFormMutation({
 *     mutationFn: (input) => api.save(input),
 *     onSuccess: (result) => commit(result.value),
 *   });
 */
export function useFormDraft<T>(
  opts: UseFormDraftOptions<T>,
): UseFormDraftReturn<T> {
  const { source } = opts;
  const equals = opts.equals ?? deepEquals;
  // Initialise from `source` when it's already available — otherwise the
  // first render leaves controlled inputs reading `undefined`, then the
  // hydrate effect swaps them to defined values, and React warns about
  // uncontrolled-to-controlled transitions. The effect below still
  // hydrates when `source` becomes available after mount.
  const [draft, setDraft] = useState<T | null>(() => source ?? null);

  useEffect(() => {
    if (source !== undefined && draft === null) {
      setDraft(source);
    }
  }, [source, draft]);

  const isDirty = useMemo(() => {
    if (draft === null || source === undefined) return false;
    return !equals(draft, source);
  }, [draft, source, equals]);

  const discard = useCallback(() => {
    if (source !== undefined) setDraft(source);
  }, [source]);

  const commit = useCallback((value: T) => {
    setDraft(value);
  }, []);

  const setField = useCallback((path: string, value: unknown) => {
    setDraft((current) =>
      current === null
        ? current
        : (setPath(current as object, path, value) as T),
    );
  }, []);

  return { draft, setDraft, setField, isDirty, discard, commit };
}
