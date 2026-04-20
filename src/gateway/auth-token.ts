import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

const AUTH_SECRET_FILE = '/run/secrets/hybridclaw_auth_secret';
export const SESSION_COOKIE_NAME = 'hybridclaw_session';
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

export interface VerifiedAuthTokenPayload extends Record<string, unknown> {
  exp: number;
}

interface ParsedToken {
  headerSegment: string | null;
  payloadSegment: string;
  signatureSegment: string;
  signedPortion: string;
}

function readSharedSecret(): string {
  try {
    const fileSecret = fs.readFileSync(AUTH_SECRET_FILE, 'utf8').trim();
    if (fileSecret) return fileSecret;
  } catch {
    // Fall back to the environment variable.
  }

  return (process.env.HYBRIDCLAW_AUTH_SECRET || '').trim();
}

function parseSignedToken(token: string): ParsedToken | null {
  const trimmed = token.trim();
  if (!trimmed) return null;

  const parts = trimmed.split('.');
  if (parts.length === 2) {
    const [payloadSegment, signatureSegment] = parts;
    if (!payloadSegment || !signatureSegment) return null;
    return {
      headerSegment: null,
      payloadSegment,
      signatureSegment,
      signedPortion: payloadSegment,
    };
  }

  if (parts.length === 3) {
    const [headerSegment, payloadSegment, signatureSegment] = parts;
    if (!headerSegment || !payloadSegment || !signatureSegment) return null;
    return {
      headerSegment,
      payloadSegment,
      signatureSegment,
      signedPortion: `${headerSegment}.${payloadSegment}`,
    };
  }

  return null;
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(segment, 'base64url').toString('utf8'),
    ) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeExpirySeconds(
  payload: Record<string, unknown>,
): number | null {
  const candidate =
    payload.exp ?? payload.expiresAt ?? payload.expires_at ?? null;
  const value =
    typeof candidate === 'string' && /^\d+$/.test(candidate.trim())
      ? Number(candidate.trim())
      : candidate;

  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return value >= 1_000_000_000_000
    ? Math.floor(value / 1000)
    : Math.floor(value);
}

function safeEqual(value: string, expected: string): boolean {
  const valueBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  if (valueBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(valueBuffer, expectedBuffer);
}

function hasValidSignature(
  signedPortion: string,
  signatureSegment: string,
  secret: string,
): boolean {
  const digest = createHmac('sha256', secret).update(signedPortion).digest();
  return (
    safeEqual(signatureSegment, digest.toString('base64url')) ||
    safeEqual(signatureSegment, digest.toString('hex'))
  );
}

function verifySignedToken(
  token: string,
  secret: string,
): VerifiedAuthTokenPayload | null {
  const parsed = parseSignedToken(token);
  if (!parsed) return null;

  if (
    !hasValidSignature(parsed.signedPortion, parsed.signatureSegment, secret)
  ) {
    return null;
  }

  if (parsed.headerSegment) {
    const header = decodeJsonSegment(parsed.headerSegment);
    if (header?.alg !== 'HS256') return null;
  }

  const payload = decodeJsonSegment(parsed.payloadSegment);
  if (!payload) return null;

  const exp = normalizeExpirySeconds(payload);
  if (!exp || exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }

  return { ...payload, exp };
}

function requireVerifiedToken(token: string): VerifiedAuthTokenPayload {
  const secret = readSharedSecret();
  if (!secret) {
    throw new Error('HybridClaw auth secret is not configured.');
  }

  const payload = verifySignedToken(token, secret);
  if (!payload) {
    throw new Error('Invalid or expired auth token.');
  }

  return payload;
}

function signPayload(payload: Record<string, unknown>, secret: string): string {
  const payloadSegment = Buffer.from(JSON.stringify(payload)).toString(
    'base64url',
  );
  const signatureSegment = createHmac('sha256', secret)
    .update(payloadSegment)
    .digest('base64url');
  return `${payloadSegment}.${signatureSegment}`;
}

function extractCookieValue(
  cookieHeader: string | string[] | undefined,
  cookieName: string,
): string | null {
  const source = Array.isArray(cookieHeader)
    ? cookieHeader.join('; ')
    : cookieHeader || '';
  if (!source) return null;

  for (const segment of source.split(';')) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;
    const name = trimmed.slice(0, separatorIndex);
    if (name !== cookieName) continue;
    return trimmed.slice(separatorIndex + 1);
  }

  return null;
}

function appendSetCookie(res: ServerResponse, cookie: string): void {
  const existing = res.getHeader('Set-Cookie');
  if (existing === undefined) {
    res.setHeader('Set-Cookie', cookie);
    return;
  }

  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing.map(String), cookie]);
    return;
  }

  res.setHeader('Set-Cookie', [String(existing), cookie]);
}

export function verifyLaunchToken(token: string): VerifiedAuthTokenPayload {
  return requireVerifiedToken(token);
}

export function getSessionAuthPayload(
  req: IncomingMessage,
): VerifiedAuthTokenPayload | null {
  const token = extractCookieValue(req.headers.cookie, SESSION_COOKIE_NAME);
  if (!token) return null;

  try {
    const payload = requireVerifiedToken(token);
    return payload.typ === 'session' ? payload : null;
  } catch {
    return null;
  }
}

export function hasSessionAuth(req: IncomingMessage): boolean {
  return getSessionAuthPayload(req) !== null;
}

export function setSessionCookie(
  res: ServerResponse,
  payload: Record<string, unknown>,
): void {
  const secret = readSharedSecret();
  if (!secret) {
    throw new Error('HybridClaw auth secret is not configured.');
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + SESSION_TTL_SECONDS;
  const token = signPayload(
    {
      ...payload,
      exp: expiresAt,
      iat: issuedAt,
      typ: 'session',
    },
    secret,
  );

  appendSetCookie(
    res,
    [
      `${SESSION_COOKIE_NAME}=${token}`,
      'Path=/',
      `Max-Age=${SESSION_TTL_SECONDS}`,
      `Expires=${new Date(expiresAt * 1000).toUTCString()}`,
      'HttpOnly',
      'SameSite=Lax',
    ].join('; '),
  );
}
