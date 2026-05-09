import { afterEach, expect, test, vi } from 'vitest';

import { sendThreemaSimpleText } from '../src/channels/threema/api.js';
import {
  normalizeThreemaChannelId,
  parseThreemaTarget,
} from '../src/channels/threema/target.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('normalizes Threema ID targets', () => {
  expect(normalizeThreemaChannelId('threema:abcdefgh')).toBe(
    'threema:ABCDEFGH',
  );
  expect(parseThreemaTarget('threema:*hybrid1')).toEqual({
    kind: 'id',
    recipient: '*HYBRID1',
  });
});

test('normalizes Threema phone and email targets', () => {
  expect(normalizeThreemaChannelId('threema:phone:+41 79 123 45 67')).toBe(
    'threema:phone:41791234567',
  );
  expect(normalizeThreemaChannelId('threema:email:User@Example.COM')).toBe(
    'threema:email:user@example.com',
  );
});

test('rejects invalid Threema targets', () => {
  expect(normalizeThreemaChannelId('threema:not-a-target')).toBeUndefined();
  expect(normalizeThreemaChannelId('threema:phone:not-a-phone')).toBeUndefined();
});

test('sends Basic-mode Threema requests as form data', async () => {
  const fetchMock = vi.fn(async () => new Response('msg-123', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);

  await expect(
    sendThreemaSimpleText({
      apiBaseUrl: 'https://msgapi.example.test',
      identity: '*HYBRID1',
      secret: 'test-secret',
      target: { kind: 'phone', recipient: '41791234567' },
      text: 'hello',
    }),
  ).resolves.toBe('msg-123');

  expect(fetchMock).toHaveBeenCalledWith(
    'https://msgapi.example.test/send_simple',
    expect.objectContaining({
      method: 'POST',
      body: expect.any(URLSearchParams),
    }),
  );
  const body = fetchMock.mock.calls[0][1]?.body as URLSearchParams;
  expect(body.get('from')).toBe('*HYBRID1');
  expect(body.get('secret')).toBe('test-secret');
  expect(body.get('phone')).toBe('41791234567');
  expect(body.get('text')).toBe('hello');
  expect(body.has('to')).toBe(false);
});
