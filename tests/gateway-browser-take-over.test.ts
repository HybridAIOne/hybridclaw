import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';

const sandbox = vi.hoisted(() => ({ mode: 'host' as 'host' | 'container' }));
const audits = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('../src/config/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/config.js')>()),
  getResolvedSandboxMode: () => sandbox.mode,
}));
vi.mock('../src/audit/audit-events.js', () => ({
  makeAuditRunId: (prefix: string) => `${prefix}-run`,
  recordAuditEvent: (entry: { event: Record<string, unknown> }) => {
    audits.push(entry.event);
  },
}));

const takeOver = await import('../src/gateway/browser-take-over.js');

let gateway: http.Server;
let browser: WebSocketServer;
let gatewayUrl = '';
let browserPort = 0;
const received: Array<Record<string, unknown>> = [];

// The gateway's own wiring, minus authentication, which RBAC does in front.
function serveGateway(): Promise<void> {
  gateway = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://x').pathname;
    try {
      if (
        pathname === takeOver.TAKE_OVER_CONNECT_PATH ||
        pathname === takeOver.TAKE_OVER_FINISH_PATH
      ) {
        await takeOver.handleApiTakeOver(req, res, pathname, {
          actor: 'owner-phone',
        });
      } else {
        await takeOver.handleApiTakeOverRuntime(req, res, pathname);
      }
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode ?? 500;
      res.writeHead(status).end(JSON.stringify({ error: String(error) }));
    }
  });
  gateway.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://x');
    const id = takeOver.consumeTakeOverStreamToken(
      url.searchParams.get('token') || '',
    );
    if (!id) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    takeOver.handleTakeOverUpgrade(req, socket, head, id);
  });
  return new Promise((resolve) =>
    gateway.listen(0, '127.0.0.1', () => {
      gatewayUrl = `127.0.0.1:${(gateway.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

// agent-browser's stream server: a frame, the tabs, and its command log.
function serveBrowser(): Promise<void> {
  browser = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  browser.on('connection', (socket) => {
    socket.send(
      JSON.stringify({
        type: 'tabs',
        tabs: [
          {
            active: true,
            title: 'Invoices',
            url: 'https://shop.example/account/invoices?session=secret',
          },
        ],
      }),
    );
    socket.send(JSON.stringify({ type: 'command', action: 'fill', value: 'x' }));
    socket.send(
      JSON.stringify({
        type: 'frame',
        data: 'anBlZw==',
        metadata: { deviceWidth: 400, deviceHeight: 820, offsetTop: 0 },
      }),
    );
    socket.on('message', (data) => received.push(JSON.parse(String(data))));
  });
  return new Promise((resolve) =>
    browser.on('listening', () => {
      browserPort = (browser.address() as AddressInfo).port;
      resolve();
    }),
  );
}

async function post(
  pathname: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://${gatewayUrl}${pathname}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
  sandbox.mode = 'host';
  received.length = 0;
  audits.length = 0;
  await serveGateway();
  await serveBrowser();
});

afterEach(async () => {
  takeOver.resetBrowserTakeOversForTests();
  await new Promise((resolve) => gateway.close(resolve));
  await new Promise((resolve) => browser.close(resolve));
});

test('relays frames and the page out and only known input in, then reports the outcome', async () => {
  const opened = await post(takeOver.TAKE_OVER_OPEN_PATH, {
    sessionId: 'main-abc',
    port: browserPort,
    reason: 'Sign in to shop.example',
  });
  expect(opened.status).toBe(200);
  const id = String(opened.body.id);

  const connected = await post(takeOver.TAKE_OVER_CONNECT_PATH, {
    sessionId: 'main-abc',
  });
  expect(connected.body).toMatchObject({ id, reason: 'Sign in to shop.example' });

  const phone = new WebSocket(`ws://${gatewayUrl}${connected.body.path}`);
  const messages: Array<Record<string, unknown>> = [];
  await new Promise<void>((resolve) => {
    phone.on('message', (data) => {
      messages.push(JSON.parse(String(data)));
      if (messages.length === 2) resolve();
    });
  });
  expect(messages).toEqual([
    {
      type: 'page',
      url: 'https://shop.example/account/invoices',
      title: 'Invoices',
    },
    { type: 'frame', data: 'anBlZw==', width: 400, height: 820 },
  ]);

  phone.send(
    JSON.stringify({
      type: 'input_mouse',
      eventType: 'mousePressed',
      x: 120,
      y: 99_999,
      button: 'left',
      clickCount: 1,
      extra: 'dropped',
    }),
  );
  phone.send(JSON.stringify({ type: 'navigate', url: 'https://evil.example' }));
  phone.send(
    JSON.stringify({
      type: 'input_keyboard',
      eventType: 'keyDown',
      key: 'a',
      code: 'KeyA',
      text: 'a',
    }),
  );
  await vi.waitFor(() => expect(received).toHaveLength(2));
  expect(received[0]).toEqual({
    type: 'input_mouse',
    eventType: 'mousePressed',
    x: 120,
    y: 10_000,
    button: 'left',
    clickCount: 1,
    modifiers: 0,
  });
  expect(received[1]).toMatchObject({ type: 'input_keyboard', key: 'a' });

  expect(
    (await post(takeOver.TAKE_OVER_STATUS_PATH, { id })).body,
  ).toEqual({ state: 'active', remember: false });
  await post(takeOver.TAKE_OVER_FINISH_PATH, { id, remember: true });
  expect(
    (await post(takeOver.TAKE_OVER_STATUS_PATH, { id })).body,
  ).toEqual({ state: 'finished', remember: true });
  await vi.waitFor(() => expect(phone.readyState).toBe(WebSocket.CLOSED));
  expect(audits.map((event) => event.type)).toEqual([
    'browser.take_over_started',
    'browser.take_over_finished',
  ]);

  // A finished take-over can't be joined again.
  expect(
    (await post(takeOver.TAKE_OVER_CONNECT_PATH, { sessionId: 'main-abc' }))
      .status,
  ).toBe(404);
});

test('a stream token works once', async () => {
  await post(takeOver.TAKE_OVER_OPEN_PATH, {
    sessionId: 'main-abc',
    port: browserPort,
  });
  const { body } = await post(takeOver.TAKE_OVER_CONNECT_PATH, {
    sessionId: 'main-abc',
  });
  const first = new WebSocket(`ws://${gatewayUrl}${body.path}`);
  await new Promise((resolve) => first.on('open', resolve));
  const second = new WebSocket(`ws://${gatewayUrl}${body.path}`);
  const failed = await new Promise<string>((resolve) =>
    second.on('error', (error) => resolve(error.message)),
  );
  expect(failed).toContain('401');
  first.close();
});

test('nothing to take over in another chat or outside host sandbox mode', async () => {
  await post(takeOver.TAKE_OVER_OPEN_PATH, {
    sessionId: 'main-abc',
    port: browserPort,
  });
  expect(
    (await post(takeOver.TAKE_OVER_CONNECT_PATH, { sessionId: 'other' })).status,
  ).toBe(404);

  sandbox.mode = 'container';
  expect(
    (
      await post(takeOver.TAKE_OVER_OPEN_PATH, {
        sessionId: 'main-abc',
        port: browserPort,
      })
    ).status,
  ).toBe(409);
});
