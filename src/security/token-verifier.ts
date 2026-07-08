import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const TOKEN_VERIFIER_SALT_BYTES = 16;
const TOKEN_VERIFIER_BYTES = 32;
const TOKEN_VERIFIER_PREFIX = 'scrypt:v1';
const TOKEN_SCRYPT_OPTIONS = {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
} as const;

function deriveScryptVerifier(token: string, salt: Buffer): Buffer {
  return scryptSync(token, salt, TOKEN_VERIFIER_BYTES, TOKEN_SCRYPT_OPTIONS);
}

export function createScryptVerifier(token: string): string {
  const salt = randomBytes(TOKEN_VERIFIER_SALT_BYTES);
  const verifier = deriveScryptVerifier(token, salt);
  return [
    TOKEN_VERIFIER_PREFIX,
    salt.toString('base64url'),
    verifier.toString('base64url'),
  ].join(':');
}

function parseStoredScryptVerifier(value: string): {
  salt: Buffer;
  verifier: Buffer;
} | null {
  const [scheme, version, rawSalt, rawVerifier, extra] = value.split(':');
  if (
    scheme !== 'scrypt' ||
    version !== 'v1' ||
    !rawSalt ||
    !rawVerifier ||
    extra !== undefined
  ) {
    return null;
  }
  const salt = Buffer.from(rawSalt, 'base64url');
  const verifier = Buffer.from(rawVerifier, 'base64url');
  if (
    salt.length !== TOKEN_VERIFIER_SALT_BYTES ||
    verifier.length !== TOKEN_VERIFIER_BYTES
  ) {
    return null;
  }
  return { salt, verifier };
}

export function isScryptVerifierMatch(
  token: string,
  storedVerifier: string,
): boolean {
  const parsed = parseStoredScryptVerifier(storedVerifier);
  if (!parsed) return false;
  const presentedVerifier = deriveScryptVerifier(token, parsed.salt);
  if (presentedVerifier.length !== parsed.verifier.length) return false;
  return timingSafeEqual(presentedVerifier, parsed.verifier);
}
