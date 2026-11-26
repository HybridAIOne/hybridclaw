import {
  HYBRIDAI_API_KEY,
  HYBRIDAI_BASE_URL,
  MSTEAMS_APP_ID,
  MSTEAMS_APP_PASSWORD,
} from '../../config/config.js';
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

/**
 * How an enabled Teams channel is served: with the gateway's own bot
 * credentials, through the relay when none are entered at all, or not yet
 * when they are half entered.
 */
export function resolveMSTeamsMode(): 'credentials' | 'relay' | 'incomplete' {
  const appId = String(MSTEAMS_APP_ID || '').trim();
  const password = String(MSTEAMS_APP_PASSWORD || '').trim();
  if (appId && password) return 'credentials';
  return !appId && !password && resolveMSTeamsRelay() ? 'relay' : 'incomplete';
}
