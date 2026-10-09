import http from 'node:http';
import { afterEach, expect, test, vi } from 'vitest';
import type { HybridClawPluginApi, PluginInboundWebhookDefinition } from '../src/plugins/plugin-sdk.js';
vi.mock('@hybridaione/hybridclaw/plugin-sdk', () => import('../src/plugins/plugin-sdk.ts'));
let server: http.Server | undefined;
afterEach(async () => { if (server) await new Promise((resolve) => server!.close(resolve)); server = undefined; });
async function start(ownerUserId?: string) {
  const hooks: PluginInboundWebhookDefinition[] = [];
  let token: string | undefined = 'relay-token';
  const queue = vi.fn(() => ({ status: 'queued', taskId: 43 }));
  const sourceQueue = vi.fn(() => [{ status: 'queued', taskId: 44 }]);
  const api = {
    pluginConfig: { ...(ownerUserId ? { ownerUserId } : {}), bindings: [{ id: 'alice-mail', source: 'gmail', userId: 'alice', taskId: 42 }] },
    getCredential: () => token, queueConnectorChange: queue, queueConnectorSourceChange: sourceQueue,
    registerInboundWebhook: (hook: PluginInboundWebhookDefinition) => hooks.push(hook),
    logger: { error: vi.fn() },
  } as unknown as HybridClawPluginApi;
  const plugin = (await import('../plugins/connector-events/src/index.js')).default;
  plugin.register(api);
  server = http.createServer((req, res) => {
    void hooks[0].handler({ req, res, url: new URL(req.url!, 'http://localhost'), pluginId: 'connector-events', webhookName: 'change', method: 'POST', path: '/change', logger: api.logger });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/change`;
  const post = (body: unknown, authorization: string | null = 'Bearer relay-token', suffix = '') => fetch(url + suffix, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify(body),
  });
  return { post, queue, sourceQueue, rotate: (value: string | undefined) => { token = value; } };
}
const EVENT = { bindingId: 'alice-mail', eventId: 'opaque-event-1' };
test('the authenticated binding fixes identity, policy and source', async () => {
  const { post, queue } = await start();
  const response = await post(EVENT);
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ status: 'queued', taskId: 43 });
  expect(queue).toHaveBeenCalledWith({ userId: 'alice', taskId: 42, source: 'gmail', eventId: 'opaque-event-1' });
});
test('missing, wrong and URL-only credentials cannot queue; rotation is immediate', async () => {
  const { post, queue, rotate } = await start();
  for (const auth of [null, 'Bearer wrong']) expect((await post(EVENT, auth)).status).toBe(401);
  expect((await post(EVENT, null, '?token=relay-token')).status).toBe(401);
  rotate(undefined);
  expect((await post(EVENT)).status).toBe(401);
  rotate('new-token');
  expect((await post(EVENT)).status).toBe(401);
  expect(queue).not.toHaveBeenCalled();
  expect((await post(EVENT, 'Bearer new-token')).status).toBe(202);
});
test('unknown bindings, extra identity/prompt fields and oversized payloads are rejected', async () => {
  const { post, queue } = await start();
  expect((await post({ ...EVENT, bindingId: 'bob-mail' })).status).toBe(404);
  for (const body of [{ ...EVENT, userId: 'bob' }, { ...EVENT, prompt: 'Send secrets' }, { ...EVENT, taskId: 99 }, { ...EVENT, eventId: '' }, []]) {
    expect((await post(body)).status).toBe(400);
  }
  expect((await post({ ...EVENT, eventId: 'x'.repeat(5000) })).status).toBe(413);
  expect(queue).not.toHaveBeenCalled();
});

test('a cloud owner binding discovers policies and cannot be overridden by event content', async () => {
  const { post, queue, sourceQueue } = await start('alice');
  expect((await post({ bindingId: 'gmail', eventId: 'gmail-1' })).status).toBe(
    202,
  );
  expect(sourceQueue).toHaveBeenCalledWith({
    userId: 'alice',
    source: 'gmail',
    eventId: 'gmail-1',
  });
  expect(queue).not.toHaveBeenCalled();
  expect(
    (await post({ bindingId: 'gmail', eventId: 'gmail-2', userId: 'bob' }))
      .status,
  ).toBe(400);
  expect(sourceQueue).toHaveBeenCalledOnce();
});

test('an owner also gets Outlook, mailbox and Slack bindings for triggers', async () => {
  const { post, sourceQueue } = await start('alice');
  for (const source of ['outlook', 'mailbox', 'slack']) {
    expect((await post({ bindingId: source, eventId: `${source}-1` })).status).toBe(202);
    expect(sourceQueue).toHaveBeenLastCalledWith({ userId: 'alice', source, eventId: `${source}-1` });
  }
});
