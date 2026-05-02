export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const A2A_TRANSPORT_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

export function normalizeTransportString(transport: string): string {
  return transport.trim().toLowerCase();
}
