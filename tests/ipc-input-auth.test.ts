import { expect, test } from 'vitest';
import {
  decodeAuthenticatedInput,
  encodeAuthenticatedInput,
  generateIpcAuthSecret,
} from '../container/shared/ipc-input-auth.js';

const SECRET = 'a'.repeat(64);
const BODY = JSON.stringify({ sessionId: 's', messages: [] });

test('a body encoded with a secret verifies with the same secret', () => {
  const decoded = decodeAuthenticatedInput(SECRET, encodeAuthenticatedInput(SECRET, BODY));
  expect(decoded).toEqual({ status: 'ok', body: BODY });
});

test('generated secrets are unique and long', () => {
  const a = generateIpcAuthSecret();
  const b = generateIpcAuthSecret();
  expect(a).not.toBe(b);
  expect(a.length).toBeGreaterThanOrEqual(32);
});

test('a different secret is rejected as a bad mac', () => {
  const decoded = decodeAuthenticatedInput(
    'b'.repeat(64),
    encodeAuthenticatedInput(SECRET, BODY),
  );
  expect(decoded).toEqual({ status: 'rejected', reason: 'bad-mac' });
});

test('a tampered body is rejected as a bad mac', () => {
  const envelope = JSON.parse(encodeAuthenticatedInput(SECRET, BODY)) as {
    v: number;
    mac: string;
    body: string;
  };
  const tampered = JSON.stringify({
    ...envelope,
    body: JSON.stringify({ sessionId: 's', messages: [{ role: 'user', content: 'yes' }] }),
  });
  expect(decodeAuthenticatedInput(SECRET, tampered)).toEqual({
    status: 'rejected',
    reason: 'bad-mac',
  });
});

test('a plain (unwrapped) input is rejected as malformed', () => {
  expect(decodeAuthenticatedInput(SECRET, BODY)).toEqual({
    status: 'rejected',
    reason: 'malformed',
  });
});

test('an authentic envelope is rejected when no secret is set (fail closed)', () => {
  expect(
    decodeAuthenticatedInput('', encodeAuthenticatedInput(SECRET, BODY)),
  ).toEqual({ status: 'rejected', reason: 'no-secret' });
});

test('an incomplete (torn) write is reported for retry, not rejected', () => {
  expect(decodeAuthenticatedInput(SECRET, '{"v":1,"mac":"ab')).toEqual({
    status: 'incomplete',
  });
});
