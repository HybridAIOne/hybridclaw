import { HYBRIDAI_API_KEY, HYBRIDAI_BASE_URL } from '../../config/config.js';
import type { MSTeamsRelay } from './adapter.js';

/**
 * The HybridAI platform can own the Teams bot for a gateway signed in to it:
 * it delivers verified activities to `/api/msteams/relay` and carries the
 * gateway's connector calls, so no bot credentials are configured here.
 */
export function resolveMSTeamsRelay(): MSTeamsRelay | null {
  const baseUrl = String(HYBRIDAI_BASE_URL || '').trim();
  const token = String(HYBRIDAI_API_KEY || '').trim();
  return baseUrl && token ? { baseUrl, token } : null;
}
