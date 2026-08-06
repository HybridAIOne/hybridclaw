/**
 * Vonage JWT primitives, hand-rolled on node:crypto to avoid an SDK
 * dependency.
 *
 * Two distinct trust directions share this file and must not be conflated:
 * minting RS256 application JWTs (our application private key → Vonage REST
 * API) and verifying HS256 signed-callback JWTs (Vonage → our webhooks,
 * keyed by the account signature secret, body pinned via payload_hash).
 * Unsigned or stale callbacks are rejected — verification never soft-fails.
 *
 * NOT a general JWT library: exactly the algorithms and claims Vonage uses.
 */
import {
  createHash,
  createHmac,
  createSign,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { isRecord } from '../../../utils/type-guards.js';

const APPLICATION_JWT_TTL_SECONDS = 900;
// 300s (owner call, 2026-08-06): max accepted webhook JWT age; pairs with the
// jti replay window in the runtime so a replayed signed callback is rejected
// by iat once it ages out of the replay cache.
export const WEBHOOK_JWT_MAX_AGE_SECONDS = 300;
const WEBHOOK_JWT_MAX_CLOCK_SKEW_SECONDS = 30;

function base64UrlEncode(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url');
}

function base64UrlDecode(segment: string): Buffer | null {
  try {
    return Buffer.from(segment, 'base64url');
  } catch {
    return null;
  }
}

export function normalizeVonagePrivateKey(raw: string): string {
  // Secret stores and env vars commonly hold PEM keys with literal "\n"
  // escapes; restore real newlines before handing the key to node:crypto.
  return String(raw || '')
    .replace(/\\n/g, '\n')
    .trim();
}

export function mintVonageApplicationJwt(params: {
  applicationId: string;
  privateKey: string;
  nowSeconds?: number;
}): string {
  const applicationId = String(params.applicationId || '').trim();
  const privateKey = normalizeVonagePrivateKey(params.privateKey);
  if (!applicationId || !privateKey) {
    throw new Error('Vonage application ID and private key are required.');
  }
  const iat = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      application_id: applicationId,
      iat,
      exp: iat + APPLICATION_JWT_TTL_SECONDS,
      jti: randomUUID(),
    }),
  );
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(privateKey)
    .toString('base64url');
  return `${header}.${payload}.${signature}`;
}

export interface VonageWebhookJwtClaims {
  jti: string;
  iat: number;
}

export function extractBearerToken(
  authorizationHeader: string | null | undefined,
): string {
  const raw = String(authorizationHeader || '').trim();
  if (!/^bearer\s/i.test(raw)) {
    return '';
  }
  return raw.replace(/^bearer\s+/i, '').trim();
}

export function verifyVonageWebhookJwt(params: {
  token: string;
  signatureSecret: string;
  rawBody: string;
  nowSeconds?: number;
}): VonageWebhookJwtClaims | null {
  const token = String(params.token || '').trim();
  const signatureSecret = String(params.signatureSecret || '');
  if (!token || !signatureSecret) {
    return null;
  }
  const segments = token.split('.');
  if (segments.length !== 3) {
    return null;
  }
  const [headerSegment, payloadSegment, signatureSegment] = segments;

  const headerBuffer = base64UrlDecode(headerSegment);
  const payloadBuffer = base64UrlDecode(payloadSegment);
  const actualSignature = base64UrlDecode(signatureSegment);
  if (!headerBuffer || !payloadBuffer || !actualSignature) {
    return null;
  }

  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(headerBuffer.toString('utf8'));
    payload = JSON.parse(payloadBuffer.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(header) || header.alg !== 'HS256' || !isRecord(payload)) {
    return null;
  }

  const expectedSignature = createHmac('sha256', signatureSecret)
    .update(`${headerSegment}.${payloadSegment}`)
    .digest();
  if (
    expectedSignature.length !== actualSignature.length ||
    !timingSafeEqual(expectedSignature, actualSignature)
  ) {
    return null;
  }

  const iat = typeof payload.iat === 'number' ? payload.iat : Number.NaN;
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (
    !Number.isFinite(iat) ||
    iat > now + WEBHOOK_JWT_MAX_CLOCK_SKEW_SECONDS ||
    now - iat > WEBHOOK_JWT_MAX_AGE_SECONDS
  ) {
    return null;
  }

  const payloadHash =
    typeof payload.payload_hash === 'string' ? payload.payload_hash : '';
  if (params.rawBody) {
    if (!payloadHash) {
      return null;
    }
    const expectedHash = createHash('sha256')
      .update(params.rawBody, 'utf8')
      .digest('hex');
    const expectedDigest = createHash('sha256')
      .update(expectedHash, 'utf8')
      .digest();
    const actualDigest = createHash('sha256')
      .update(payloadHash.toLowerCase(), 'utf8')
      .digest();
    if (!timingSafeEqual(expectedDigest, actualDigest)) {
      return null;
    }
  }

  return {
    jti: typeof payload.jti === 'string' ? payload.jti : '',
    iat,
  };
}
