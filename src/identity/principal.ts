import { formatUserId, parseUserId } from './user-id.js';

const HYBRIDAI_EMAIL_AUTHORITY = 'hybridai.one';
const HYBRIDAI_PRINCIPAL_AUTHORITY = 'hybridai';

export class PrincipalValidationError extends Error {
  constructor(message: string) {
    super(`Invalid principal: ${message}`);
    this.name = 'PrincipalValidationError';
  }
}

export function normalizePrincipal(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PrincipalValidationError('a user id or email is required');
  }

  try {
    const parsed = parseUserId(value);
    return parsed.authority === HYBRIDAI_EMAIL_AUTHORITY
      ? formatUserId(parsed.username, HYBRIDAI_PRINCIPAL_AUTHORITY)
      : parsed.id;
  } catch (error) {
    throw new PrincipalValidationError(
      error instanceof Error ? error.message : 'user id is invalid',
    );
  }
}

export function tryNormalizePrincipal(value: unknown): string | null {
  try {
    return normalizePrincipal(value);
  } catch {
    return null;
  }
}
