import { expect, test, vi } from 'vitest';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { useCleanMocks, useTempDir } from './test-utils.js';
const temp = useTempDir();
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../src/agent/proactive-policy.js', () => ({
  isWithinActiveHours: () => true,
}));
vi.mock('../src/gateway/proactive-delivery.js', () => ({
  shouldDropQueuedProactiveMessage: () => false,
  hasImmediateProactiveDeliveryPath: () => true,
}));
vi.mock('../src/gateway/proactive-dispatch.js', () => ({
  MAX_QUEUED_PROACTIVE_MESSAGES: 100,
  sendProactiveMessageNow: mocks.send,
}));
useCleanMocks({
  cleanup: cleanupGatewayRuntime,
  resetModules: true,
  unstubAllEnvs: true,
});
async function setup() {
  vi.stubEnv('HOME', temp());
  mocks.send.mockReset();
  (await import('../src/memory/db.js')).initDatabase({ quiet: true });
  const queue = await import('../src/memory/proactive-queue.js');
  const { flushQueuedProactiveMessages: flush } = await import(
    '../src/gateway/proactive-queue-flush.js'
  );
  queue.enqueueProactiveMessage(
    'test-channel',
    'A reminder',
    'schedule:1',
    100,
  );
  return { queue, flush };
}
test('overlapping flushes deliver a selected row only once', async () => {
  const { queue, flush } = await setup();
  let release!: () => void;
  const pending = new Promise<void>((done) => {
    release = done;
  });
  mocks.send.mockImplementation(async () => {
    await pending;
    return { status: 'sent' };
  });
  const first = flush();
  const second = flush();
  release();
  await Promise.all([first, second]);
  expect(mocks.send).toHaveBeenCalledOnce();
  expect(queue.getQueuedProactiveMessageCount()).toBe(0);
});
test('a thrown sender failure releases ownership for the next flush', async () => {
  const { queue, flush } = await setup();
  mocks.send.mockRejectedValueOnce(new Error('Test sender failure'));
  await expect(flush()).rejects.toThrow('Test sender failure');
  expect(queue.getQueuedProactiveMessageCount()).toBe(1);
  mocks.send.mockResolvedValue({ status: 'sent' });
  await flush();
  expect(queue.getQueuedProactiveMessageCount()).toBe(0);
});
