import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Returns an identity-stable wrapper around a callback. The wrapper always
 * invokes the latest version of `callback` passed in, but its reference does
 * not change across renders — so it is safe to list as an effect dependency
 * without re-running the effect when the parent passes an inline arrow.
 *
 * This is the well-known "useEvent" pattern (still experimental in React).
 */
export function useStableCallback<Args extends unknown[], R>(
  callback: (...args: Args) => R,
): (...args: Args) => R {
  const ref = useRef(callback);
  // useLayoutEffect (not useEffect) so the ref is updated before any
  // synchronous child render/layout-effect that might invoke the stable
  // wrapper in the same commit — matching React's own `useEvent` shim. Safe
  // here because the console is a client-only SPA (no SSR hydration).
  useLayoutEffect(() => {
    ref.current = callback;
  });
  return useCallback((...args: Args) => ref.current(...args), []);
}
