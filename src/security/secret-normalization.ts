export function normalizeSecretString(value: unknown): string {
  return String(value ?? '').trim();
}

export function normalizeSecretLower(value: unknown): string {
  return normalizeSecretString(value).toLowerCase();
}

export function normalizeSecretSessionId(sessionId: unknown): string {
  return normalizeSecretString(sessionId) || 'secret-resolution';
}
