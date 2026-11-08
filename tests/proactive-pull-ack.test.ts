import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { expect, test, vi } from 'vitest';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { useCleanMocks, useTempDir } from './test-utils.js';
const temp = useTempDir();
useCleanMocks({
  cleanup: cleanupGatewayRuntime,
  resetModules: true,
  unstubAllEnvs: true,
});
async function setup() {
  vi.stubEnv('HOME', temp());
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true });
  const queue = await import('../src/memory/proactive-queue.js');
  queue.enqueueProactiveMessage('tui', 'A reminder', 'schedule:1', 100);
  return { db, queue };
}
function response() {
  let status = 0;
  let payload: Record<string, unknown> = {};
  const res = {
    writeHead: (value: number) => {
      status = value;
    },
    end: (body: string) => {
      payload = JSON.parse(body);
    },
  } as unknown as ServerResponse;
  return { res, result: () => ({ status, payload }) };
}
function request(body: unknown): IncomingMessage {
  return Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
}
test('a disconnected pull retains its message and redelivers after expiry across database reopen', async () => {
  const { db, queue } = await setup();
  const [first] = queue.claimQueuedProactiveMessages('tui');
  expect(queue.getQueuedProactiveMessageCount()).toBe(1);
  expect(queue.claimQueuedProactiveMessages('tui')).toEqual([]);
  db.closeDatabase();
  db.initDatabase({ quiet: true });
  expect(queue.getQueuedProactiveMessageCount()).toBe(1);
  db.withMemoryDatabase((database) =>
    database
      .prepare('UPDATE proactive_message_queue SET claim_expires_at = ?')
      .run('2000-01-01T00:00:00.000Z'),
  );
  const [retry] = queue.claimQueuedProactiveMessages('tui');
  expect(retry.id).toBe(first.id);
  expect(retry.claim_token).not.toBe(first.claim_token);
  expect(
    queue.acknowledgeProactiveMessages('tui', first.claim_token!, [first.id]),
  ).toBe(0);
  expect(
    queue.acknowledgeProactiveMessages('other-channel', retry.claim_token!, [
      retry.id,
    ]),
  ).toBe(0);
  expect(
    queue.acknowledgeProactiveMessages('tui', retry.claim_token!, [retry.id]),
  ).toBe(1);
  expect(
    queue.acknowledgeProactiveMessages('tui', retry.claim_token!, [retry.id]),
  ).toBe(0);
  expect(queue.getQueuedProactiveMessageCount()).toBe(0);
});
test('HTTP pull and acknowledgement retain data until the client handles it', async () => {
  const { queue } = await setup();
  const handlers = await import('../src/gateway/proactive-pull.js');
  const pull = response();
  handlers.handleApiProactivePull(
    pull.res,
    new URL('http://example.com/api/proactive/pull?channelId=tui'),
  );
  expect(pull.result().status).toBe(200);
  const batch = pull.result().payload as unknown as {
    claimToken: string;
    messages: Array<{ id: number }>;
  };
  expect(queue.getQueuedProactiveMessageCount()).toBe(1);
  const ack = response();
  await handlers.handleApiProactiveAcknowledge(
    request({
      channelId: 'tui',
      claimToken: batch.claimToken,
      ids: batch.messages.map((message) => message.id),
    }),
    ack.res,
  );
  expect(ack.result()).toEqual({ status: 200, payload: { acknowledged: 1 } });
  expect(queue.getQueuedProactiveMessageCount()).toBe(0);
});
test.each([
  {},
  { channelId: 'tui', claimToken: 'test-token', ids: [-1] },
  { channelId: 'tui', claimToken: 'test-token', ids: ['1'] },
  { channelId: 'discord:example', claimToken: 'test-token', ids: [1] },
])('invalid acknowledgements cannot remove messages: %j', async (body) => {
  const { queue } = await setup();
  const { handleApiProactiveAcknowledge } = await import(
    '../src/gateway/proactive-pull.js'
  );
  const reply = response();
  await handleApiProactiveAcknowledge(request(body), reply.res);
  expect(reply.result().status).toBe(400);
  expect(queue.getQueuedProactiveMessageCount()).toBe(1);
});
test('schema upgrade preserves queued messages', async () => {
  const { db, queue } = await setup();
  db.withMemoryDatabase((database) => {
    database.exec(
      'ALTER TABLE proactive_message_queue DROP COLUMN claim_token; ALTER TABLE proactive_message_queue DROP COLUMN claim_expires_at; PRAGMA user_version = 80;',
    );
  });
  db.closeDatabase();
  db.initDatabase({ quiet: true });
  expect(queue.claimQueuedProactiveMessages('tui')[0]).toMatchObject({
    text: 'A reminder',
    claim_token: expect.any(String),
  });
});

test('nonlocal channels cannot be pulled by a local client', async () => {
  const { queue } = await setup();
  const { handleApiProactivePull } = await import('../src/gateway/proactive-pull.js');
  const reply = response();
  handleApiProactivePull(reply.res, new URL('http://example.com/api/proactive/pull?channelId=discord:example'));
  expect(reply.result().status).toBe(400);
  expect(queue.getQueuedProactiveMessageCount()).toBe(1);
});
