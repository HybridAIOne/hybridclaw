/**
 * Secret-backed header values for `POST /api/http/request`. An entry with
 * `cookie: NAME` injects only that cookie from a secret holding a Cookie
 * header (double-submit CSRF) and fails when the cookie is missing, never
 * falling back to the whole secret. NOT the resolver: policy, domain binding,
 * and audit run on the whole secret in `gateway-http-proxy.ts` first.
 */

import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { rememberResolvedSecretForLeakScan } from '../security/secret-leak-corpus.js';
import { normalizeSecretSessionId } from '../security/secret-normalization.js';
import { extractCookieValue } from './auth-token.js';

export type HttpRequestSecretHeader = {
  name: string;
  secretName: string;
  prefix: string;
  cookie?: string;
};

// RFC 6265 cookie-name token: visible ASCII without separators.
const COOKIE_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function normalizeSecretHeaderCookie(
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !COOKIE_NAME_RE.test(value)) {
    throw new GatewayRequestError(
      400,
      '`secretHeaders[].cookie` must be a cookie name.',
    );
  }
  return value;
}

export function secretHeaderValue(
  secret: string,
  header: HttpRequestSecretHeader,
  sessionId?: string,
): string {
  if (header.cookie === undefined) return secret;
  const value = extractCookieValue(secret, header.cookie);
  if (!value) {
    throw new GatewayRequestError(
      400,
      `Stored secret ${header.secretName} has no ${header.cookie} cookie.`,
    );
  }
  // The whole secret is already tracked; a leak of this part alone is not.
  rememberResolvedSecretForLeakScan({
    sessionId: normalizeSecretSessionId(sessionId),
    secretId: header.secretName,
    value,
  });
  return value;
}
