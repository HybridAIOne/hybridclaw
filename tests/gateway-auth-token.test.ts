import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, test, vi } from 'vitest';

const ORIGINAL_HYBRIDCLAW_AUTH_SECRET = process.env.HYBRIDCLAW_AUTH_SECRET;

function signAuthPayload(
  payload: Record<string, unknown>,
  secret: string,
): string {
  const payloadSegment = Buffer.from(JSON.stringify(payload)).toString(
    'base64url',
  );
  const signature = createHmac('sha256', secret)
    .update(payloadSegment)
    .digest('base64url');
  return `${payloadSegment}.${signature}`;
}

function makeResponse() {
  const headers: Record<string, string | string[]> = {};

  return {
    headers,
    getHeader(name: string) {
      return headers[name];
    },
    setHeader(name: string, value: string | string[]) {
      headers[name] = value;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  if (ORIGINAL_HYBRIDCLAW_AUTH_SECRET === undefined) {
    delete process.env.HYBRIDCLAW_AUTH_SECRET;
  } else {
    process.env.HYBRIDCLAW_AUTH_SECRET = ORIGINAL_HYBRIDCLAW_AUTH_SECRET;
  }
});

describe('gateway auth token helpers', () => {
  test('verifies a valid launch token signed with the shared secret', async () => {
    process.env.HYBRIDCLAW_AUTH_SECRET = 'unit-secret';
    const { verifyLaunchToken } = await import('../src/gateway/auth-token.ts');
    const token = signAuthPayload(
      {
        exp: Math.floor(Date.now() / 1000) + 60,
        sub: 'user-1',
      },
      'unit-secret',
    );

    expect(verifyLaunchToken(token)).toMatchObject({
      sub: 'user-1',
    });
  });

  test('rejects tampered or expired launch tokens', async () => {
    process.env.HYBRIDCLAW_AUTH_SECRET = 'unit-secret';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-17T12:00:00.000Z'));
    const { verifyLaunchToken } = await import('../src/gateway/auth-token.ts');
    const validToken = signAuthPayload(
      {
        exp: Math.floor(Date.now() / 1000) + 60,
        sub: 'user-1',
      },
      'unit-secret',
    );
    const expiredToken = signAuthPayload(
      {
        exp: Math.floor(Date.now() / 1000) - 1,
        sub: 'user-1',
      },
      'unit-secret',
    );

    expect(() => verifyLaunchToken(`${validToken}x`)).toThrow(
      'Invalid or expired auth token.',
    );
    expect(() => verifyLaunchToken(expiredToken)).toThrow(
      'Invalid or expired auth token.',
    );
  });

  test('sets an HttpOnly signed session cookie that hasSessionAuth accepts until it expires', async () => {
    process.env.HYBRIDCLAW_AUTH_SECRET = 'unit-secret';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-17T12:00:00.000Z'));
    const { SESSION_COOKIE_NAME, hasSessionAuth, setSessionCookie } =
      await import('../src/gateway/auth-token.ts');
    const res = makeResponse();

    setSessionCookie(res as never, { sub: 'user-1' });

    const setCookieHeader = res.headers['Set-Cookie'];
    expect(setCookieHeader).toEqual(
      expect.stringContaining(`${SESSION_COOKIE_NAME}=`),
    );
    expect(setCookieHeader).toEqual(expect.stringContaining('HttpOnly'));
    expect(setCookieHeader).toEqual(expect.stringContaining('Max-Age=86400'));

    const sessionCookie = String(setCookieHeader).split(';', 1)[0];
    expect(
      hasSessionAuth({
        headers: {
          cookie: sessionCookie,
        },
      } as never),
    ).toBe(true);

    vi.setSystemTime(new Date('2026-03-18T12:00:01.000Z'));
    expect(
      hasSessionAuth({
        headers: {
          cookie: sessionCookie,
        },
      } as never),
    ).toBe(false);
  });
});
