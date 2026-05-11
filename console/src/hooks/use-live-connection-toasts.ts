import { useEffect, useRef } from 'react';
import { useToast } from '../components/toast';
import type { LiveConnection } from './use-live-events';

/**
 * Surface SSE transport transitions as toasts on admin pages that consume
 * `useLiveEvents`. Fires only on transitions out of and back into `open`,
 * so the initial connect/error path during page load doesn't generate noise.
 *
 * The "paused" info toast is sticky (duration: 0) so a long degradation
 * stays visible; it gets dismissed both on recovery (replaced by a
 * "restored" success toast) and on component unmount, so navigating away
 * doesn't orphan it onto another page.
 */
export function useLiveConnectionToasts(connection: LiveConnection): void {
  const toast = useToast();
  const prevRef = useRef<LiveConnection>(connection);
  const pausedToastIdRef = useRef<string | null>(null);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = connection;
    if (prev === connection) return;

    if (prev === 'open' && connection === 'error') {
      pausedToastIdRef.current = toast.add({
        title: 'Live updates paused',
        description: 'Showing snapshot — retrying.',
        type: 'info',
        duration: 0,
      });
      return;
    }

    if (prev === 'error' && connection === 'open') {
      if (pausedToastIdRef.current) {
        toast.dismiss(pausedToastIdRef.current);
        pausedToastIdRef.current = null;
      }
      toast.success('Live updates restored');
    }
  }, [connection, toast]);

  useEffect(
    () => () => {
      if (pausedToastIdRef.current) {
        toast.dismiss(pausedToastIdRef.current);
        pausedToastIdRef.current = null;
      }
    },
    [toast],
  );
}
