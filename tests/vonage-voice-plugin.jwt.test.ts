import {
  createHash,
  createHmac,
  createVerify,
  generateKeyPairSync,
} from 'node:crypto';
import { expect, test } from 'vitest';
import {
  extractBearerToken,
  mintVonageApplicationJwt,
  normalizeVonagePrivateKey,
  verifyVonageWebhookJwt,
} from '../plugins/vonage-voice/src/jwt.js';

const SIGNATURE_SECRET = 'test-signature-secret-at-least-32-bytes-long';

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function buildWebhookJwt(params: {
  secret?: string;
  iat?: number;
  jti?: string | null;
  payloadHash?: string;
  alg?: string;
}): string {
  const header = Buffer.from(
    JSON.stringify({ alg: params.alg ?? 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iat: params.iat ?? Math.floor(Date.now() / 1000),
      ...(params.jti === null ? {} : { jti: params.jti ?? 'test-jti' }),
      iss: 'Vonage',
      api_key: 'test-api-key',
      ...(params.payloadHash ? { payload_hash: params.payloadHash } : {}),
    }),
  ).toString('base64url');
  const signature = createHmac('sha256', params.secret ?? SIGNATURE_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

test('mintVonageApplicationJwt produces a valid RS256 application JWT', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  const token = mintVonageApplicationJwt({
    applicationId: 'app-123',
    privateKey,
  });
  const [headerSegment, payloadSegment, signatureSegment] = token.split('.');
  expect(decodeSegment(headerSegment)).toEqual({ alg: 'RS256', typ: 'JWT' });

  const claims = decodeSegment(payloadSegment);
  expect(claims.application_id).toBe('app-123');
  expect(typeof claims.iat).toBe('number');
  expect(typeof claims.jti).toBe('string');
  expect(Number(claims.exp)).toBeGreaterThan(Number(claims.iat));

  const verified = createVerify('RSA-SHA256')
    .update(`${headerSegment}.${payloadSegment}`)
    .verify(publicKey, Buffer.from(signatureSegment, 'base64url'));
  expect(verified).toBe(true);
});

test('mintVonageApplicationJwt restores escaped PEM newlines', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const escaped = privateKey.replace(/\n/g, '\\n');
  expect(normalizeVonagePrivateKey(escaped)).toBe(privateKey.trim());
  expect(() =>
    mintVonageApplicationJwt({ applicationId: 'app-123', privateKey: escaped }),
  ).not.toThrow();
});

test('verifyVonageWebhookJwt accepts a valid signed callback with payload hash', () => {
  const rawBody = JSON.stringify({ uuid: 'call-1', status: 'answered' });
  const token = buildWebhookJwt({
    payloadHash: createHash('sha256').update(rawBody, 'utf8').digest('hex'),
  });
  const claims = verifyVonageWebhookJwt({
    token,
    signatureSecret: SIGNATURE_SECRET,
    rawBody,
  });
  expect(claims).not.toBeNull();
  expect(claims?.jti).toBe('test-jti');
});

test('verifyVonageWebhookJwt rejects a tampered body', () => {
  const rawBody = JSON.stringify({ uuid: 'call-1' });
  const token = buildWebhookJwt({
    payloadHash: createHash('sha256').update(rawBody, 'utf8').digest('hex'),
  });
  expect(
    verifyVonageWebhookJwt({
      token,
      signatureSecret: SIGNATURE_SECRET,
      rawBody: JSON.stringify({ uuid: 'call-2' }),
    }),
  ).toBeNull();
});

test('verifyVonageWebhookJwt rejects a wrong signature secret', () => {
  const token = buildWebhookJwt({ secret: 'other-secret' });
  expect(
    verifyVonageWebhookJwt({
      token,
      signatureSecret: SIGNATURE_SECRET,
      rawBody: '',
    }),
  ).toBeNull();
});

test('verifyVonageWebhookJwt rejects stale and future iat claims', () => {
  const now = Math.floor(Date.now() / 1000);
  const stale = buildWebhookJwt({ iat: now - 3600 });
  const future = buildWebhookJwt({ iat: now + 3600 });
  for (const token of [stale, future]) {
    expect(
      verifyVonageWebhookJwt({
        token,
        signatureSecret: SIGNATURE_SECRET,
        rawBody: '',
      }),
    ).toBeNull();
  }
});

test('verifyVonageWebhookJwt rejects a missing payload hash for signed bodies', () => {
  const token = buildWebhookJwt({});
  expect(
    verifyVonageWebhookJwt({
      token,
      signatureSecret: SIGNATURE_SECRET,
      rawBody: '{"uuid":"call-1"}',
    }),
  ).toBeNull();
});

test('verifyVonageWebhookJwt rejects tokens without a jti claim', () => {
  for (const jti of [null, ''] as const) {
    const token = buildWebhookJwt({ jti });
    expect(
      verifyVonageWebhookJwt({
        token,
        signatureSecret: SIGNATURE_SECRET,
        rawBody: '',
      }),
    ).toBeNull();
  }
});

test('verifyVonageWebhookJwt rejects non-HS256 algorithms', () => {
  const token = buildWebhookJwt({ alg: 'none' });
  expect(
    verifyVonageWebhookJwt({
      token,
      signatureSecret: SIGNATURE_SECRET,
      rawBody: '',
    }),
  ).toBeNull();
});

test('extractBearerToken parses Authorization headers', () => {
  expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  expect(extractBearerToken('bearer   abc')).toBe('abc');
  expect(extractBearerToken('Basic abc')).toBe('');
  expect(extractBearerToken(undefined)).toBe('');
});
