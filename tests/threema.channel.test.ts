import { afterEach, expect, test, vi } from 'vitest';

import { sendThreemaSimpleText } from '../src/channels/threema/api.js';
import {
  normalizeThreemaChannelId,
  parseThreemaTarget,
} from '../src/channels/threema/target.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
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

test('rejects non-local http Threema API base URLs', async () => {
  const fetchMock = vi.fn(async () => new Response('msg-123', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);

  await expect(
    sendThreemaSimpleText({
      apiBaseUrl: 'http://msgapi.example.test',
      identity: '*HYBRID1',
      secret: 'test-secret',
      target: { kind: 'id', recipient: '*TARGET1' },
      text: 'hello',
    }),
  ).rejects.toThrow(
    'Threema API base URL must use https unless it points to localhost.',
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

test('allows local http Threema API base URLs for tests and proxies', async () => {
  const fetchMock = vi.fn(async () => new Response('msg-123', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);

  await sendThreemaSimpleText({
    apiBaseUrl: 'http://localhost:8080',
    identity: '*HYBRID1',
    secret: 'test-secret',
    target: { kind: 'id', recipient: '*TARGET1' },
    text: 'hello',
  });

  expect(fetchMock).toHaveBeenCalledWith(
    'http://localhost:8080/send_simple',
    expect.any(Object),
  );
});

test('threads abort signals through chunked Threema delivery', async () => {
  vi.doMock('../src/config/config.js', () => ({
    THREEMA_GATEWAY_SECRET: 'test-secret',
    getConfigSnapshot: () => ({
      threema: {
        enabled: true,
        apiBaseUrl: 'https://msgapi.example.test',
        identity: '*HYBRID1',
        secret: '',
        dmPolicy: 'open',
        textChunkLimit: 3_500,
        outboundDelayMs: 0,
      },
    }),
  }));
  const fetchMock = vi.fn(async () => new Response('msg-123', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);

  const { sendChunkedThreemaText } = await import(
    '../src/channels/threema/delivery.js'
  );
  const controller = new AbortController();
  await sendChunkedThreemaText({
    signal: controller.signal,
    target: 'threema:*TARGET1',
    text: 'hello',
  });

  expect(fetchMock).toHaveBeenCalledWith(
    'https://msgapi.example.test/send_simple',
    expect.objectContaining({
      signal: controller.signal,
    }),
  );
});
