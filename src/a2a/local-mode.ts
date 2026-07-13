import type { RuntimeConfig } from '../config/runtime-config.js';

const EXTERNAL_CHANNEL_SOURCES = new Set([
  'discord',
  'email',
  'imessage',
  'line',
  'msteams',
  'signal',
  'slack',
  'telegram',
  'threema',
  'voice',
  'whatsapp',
]);

export function isA2ALocalModeEnabled(
  config: Pick<RuntimeConfig, 'deployment'>,
): boolean {
  return config.deployment.a2a_local_mode;
}

export function isA2ALocalModeExternalChannelSource(source: string): boolean {
  return EXTERNAL_CHANNEL_SOURCES.has(source.trim().toLowerCase());
}

export function isA2ALocalModePublicA2ARequest(
  method: string,
  pathname: string,
): boolean {
  if (method === 'GET' && pathname === '/.well-known/agent.json') return true;
  if (method !== 'POST') return false;
  return (
    pathname === '/a2a' ||
    pathname === '/a2a/envelopes' ||
    pathname === '/a2a/pairing/requests' ||
    pathname.startsWith('/a2a/webhook/')
  );
}

export function isA2ALocalModeAdminRequest(
  method: string,
  pathname: string,
): boolean {
  if (method === 'GET' && pathname === '/') return true;
  if (method === 'GET' && pathname === '/auth/callback') return true;
  if (method === 'GET' && pathname === '/health') return true;
  if (method === 'GET' && pathname === '/api/status') return true;
  if (method === 'GET' && pathname === '/api/events') return true;
  if (method === 'GET' && pathname.startsWith('/assets/')) return true;
  if (method === 'GET' && pathname.startsWith('/icons/')) return true;
  if (
    method === 'GET' &&
    (pathname === '/admin' || pathname.startsWith('/admin/'))
  ) {
    return true;
  }
  return pathname === '/api/admin' || pathname.startsWith('/api/admin/');
}
