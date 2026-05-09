import { useEffect, useRef } from 'react';
import { useToast } from '../components/toast';

type LiveConnection = 'idle' | 'connecting' | 'open' | 'error';

/**
 * Surface SSE transport transitions as toasts on admin pages that consume
 * `useLiveEvents`. Fires only on transitions out of and back into `open`,
 * so the initial connect/error path during page load doesn't generate noise.
 *
 * The "paused" info toast is replaced (not stacked) by the "restored"
 * success toast once the connection comes back.
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
      pausedToastIdRef.current = toast.info(
        'Live updates paused',
        'Showing snapshot — retrying.',
      );
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
}
