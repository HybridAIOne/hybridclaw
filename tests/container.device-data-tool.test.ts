import { afterEach, expect, test, vi } from 'vitest';

import {
  executeTool,
  setGatewayContext,
  setSessionContext,
} from '../container/src/tools.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-device-data-tool-',
});
const GATEWAY_URL = 'http://gateway.test';
const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  setGatewayContext(undefined, undefined, '');
  setSessionContext('');
});

test('the tool reads through the gateway what the running turn’s user shares', async () => {
  setupHome();
  const device = await import('../src/gateway/device-data.ts');
  device.writeDeviceSources('user_a', {
    calendar: 'Calendar, next 7 days (Europe/Berlin):\n- no events',
    health: 'Health, last 7 days (Europe/Berlin):\n- nothing to read',
    contacts: 'Contacts (2):\n- Anna Schmidt · sister\n- Bob Meyer · ACME',
  });
  const requests: Array<{ url: string; auth: string; body: unknown }> = [];
  // The gateway's own route: it answers for the session's running turn.
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      sessionId: string;
      source: string;
      query: string;
    };
    requests.push({
      url: String(input),
      auth: (init?.headers as Record<string, string>).Authorization,
      body,
    });
    return new Response(
      JSON.stringify({
        ok: true,
        result: device.renderDeviceDataForSession(
          body.sessionId,
          body.source || null,
          body.query || null,
        ),
      }),
    );
  }) as typeof fetch;
  setGatewayContext(GATEWAY_URL, 'gateway-token', 'web');
  setSessionContext('chat-1');

  const read = (source?: string, query?: string) =>
    executeTool(
      'device_data',
      JSON.stringify({
        ...(source ? { source } : {}),
        ...(query ? { query } : {}),
      }),
    );
  const endTurn = device.beginDeviceDataTurn('chat-1', 'user_a');
  const during = await read(' Calendar ');

  expect(requests[0]).toEqual({
    url: `${GATEWAY_URL}/api/device-data`,
    auth: 'Bearer gateway-token',
    body: { sessionId: 'chat-1', source: 'calendar', query: '' },
  });
  expect(during).toContain('- no events');
  expect(during).not.toContain('Health');
  const found = await read('contacts', ' Anna ');
  expect(requests[1].body).toEqual({
    sessionId: 'chat-1',
    source: 'contacts',
    query: 'Anna',
  });
  expect(found).toContain('- Anna Schmidt · sister');
  expect(found).not.toContain('Bob');
  endTurn();
  // Outside the user's turn, nothing.
  expect(await read()).toContain('shares nothing here');
});

test('a failed request is reported, not read as data', async () => {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: 'Unauthorized.' }), { status: 401 }),
  ) as typeof fetch;
  setGatewayContext(GATEWAY_URL, 'wrong', 'web');
  setSessionContext('chat-1');

  expect(await executeTool('device_data', '{}')).toContain(
    'phone data request failed (HTTP 401): Unauthorized.',
  );
});
