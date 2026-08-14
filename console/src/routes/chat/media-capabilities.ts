/**
 * Webchat media capability cache — exposes the gateway's current audio support.
 *
 * All message controls share one authenticated probe per token; a token change
 * (sign-in/out, session rotation) invalidates the cache, and failed probes
 * remain retryable after authentication or configuration changes.
 *
 * NOT browser feature detection; microphone and audio-element support stay local.
 */

import { useEffect, useState } from 'react';
import { fetchMediaCapabilities } from '../../api/chat';
import type { MediaCapabilitiesResponse } from '../../api/chat-types';

let cachedToken: string | null = null;
let cachedCapabilities: MediaCapabilitiesResponse | null = null;
let pendingCapabilities: Promise<MediaCapabilitiesResponse> | null = null;

function loadCapabilities(token: string): Promise<MediaCapabilitiesResponse> {
  // A token change (sign-in/out, session rotation) can change what the
  // gateway reports, so the cache is only valid for the token that filled it.
  if (token !== cachedToken) {
    cachedToken = token;
    cachedCapabilities = null;
    pendingCapabilities = null;
  }
  if (cachedCapabilities) return Promise.resolve(cachedCapabilities);
  if (pendingCapabilities) return pendingCapabilities;
  const pending = fetchMediaCapabilities(token)
    .then((capabilities) => {
      if (token === cachedToken) cachedCapabilities = capabilities;
      return capabilities;
    })
    .finally(() => {
      if (pendingCapabilities === pending) pendingCapabilities = null;
    });
  pendingCapabilities = pending;
  return pending;
}

export function useMediaCapabilities(
  token: string,
): MediaCapabilitiesResponse | null {
  const [capabilities, setCapabilities] = useState(cachedCapabilities);

  useEffect(() => {
    let mounted = true;
    void loadCapabilities(token)
      .then((next) => {
        if (mounted) setCapabilities(next);
      })
      .catch(() => {
        if (mounted) {
          setCapabilities({ dictation: false, readAloud: false });
        }
      });
    return () => {
      mounted = false;
    };
  }, [token]);

  return capabilities;
}

export function resetMediaCapabilitiesForTests(): void {
  cachedToken = null;
  cachedCapabilities = null;
  pendingCapabilities = null;
}
