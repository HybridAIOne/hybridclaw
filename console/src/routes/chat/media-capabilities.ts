/**
 * Webchat media capability cache — exposes the gateway's current audio support.
 *
 * All message controls share one authenticated probe without retaining a token;
 * failed probes remain retryable after authentication or configuration changes.
 *
 * NOT browser feature detection; microphone and audio-element support stay local.
 */

import { useEffect, useState } from 'react';
import { fetchMediaCapabilities } from '../../api/chat';
import type { MediaCapabilitiesResponse } from '../../api/chat-types';

let cachedCapabilities: MediaCapabilitiesResponse | null = null;
let pendingCapabilities: Promise<MediaCapabilitiesResponse> | null = null;

function loadCapabilities(token: string): Promise<MediaCapabilitiesResponse> {
  if (cachedCapabilities) return Promise.resolve(cachedCapabilities);
  pendingCapabilities ??= fetchMediaCapabilities(token)
    .then((capabilities) => {
      cachedCapabilities = capabilities;
      return capabilities;
    })
    .finally(() => {
      pendingCapabilities = null;
    });
  return pendingCapabilities;
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
  cachedCapabilities = null;
  pendingCapabilities = null;
}
