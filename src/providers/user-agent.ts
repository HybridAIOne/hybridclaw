import { APP_VERSION } from '../config/app-version.js';

export function buildHybridClawUserAgent(version = APP_VERSION): string {
  const normalized = String(version || '').trim() || '0.0.0';
  return `hybridclaw/${normalized}`;
}

export const HYBRIDCLAW_USER_AGENT = buildHybridClawUserAgent();
