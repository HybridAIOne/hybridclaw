import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { SILENT_REPLY_TOKEN } from '../src/agent/silent-reply.ts';
import { useCleanMocks, useTempDir } from './test-utils.ts';

vi.mock('../src/agent/agent.js', () => ({
  runAgent: vi.fn(async () => ({ status: 'success', result: 'Child result', toolsUsed: [] })),
}));
const home = useTempDir('hybridclaw-web-delegation-');
useCleanMocks({ resetModules: true, unstubAllEnvs: true });

test.each(['success', 'error', 'silent'] as const)('web delegation %s sends only visible completion alerts', async (outcome) => {
  const dir = home();
  vi.stubEnv('HOME', dir);
  const { initDatabase, getOrCreateSession, getDelegationJob } = await import('../src/memory/db.ts');
  const { enqueueDelegationBatchFromSideEffects } = await import('../src/gateway/gateway-delegation.ts');
  const { bindWebNotificationSession, notificationOperatorId, readWebNotificationState } = await import('../src/gateway/web-notification-store.ts');
  initDatabase({ quiet: true, dbPath: path.join(dir, 'hybridclaw.db') });
  const session = getOrCreateSession('web-delegation-parent', null, 'web', 'main');
  const operator = notificationOperatorId('user-a');
  bindWebNotificationSession(session.id, operator);
  const proactive = vi.fn();
  const job = enqueueDelegationBatchFromSideEffects({
    plans: [{ mode: 'single', tasks: [{ prompt: 'Do the task', model: 'test-model' }] }],
    parentSessionId: session.id,
    channelId: 'web',
    chatbotId: 'test-bot',
    enableRag: false,
    agentId: 'main',
    parentDepth: 0,
    onProactiveMessage: proactive,
    runParentTurn: async () => outcome === 'error'
      ? { status: 'error', result: null }
      : { status: 'success', result: outcome === 'silent' ? SILENT_REPLY_TOKEN : 'Parent reply' },
  });
  expect(job).not.toBeNull();
  await vi.waitFor(() => expect(getDelegationJob(job!.publicId)?.status).toBe('completed'));
  const alerts = readWebNotificationState(operator).notifications;
  expect(alerts).toHaveLength(outcome === 'silent' ? 0 : 1);
  if (outcome !== 'silent') expect(alerts[0]).toMatchObject({ sessionId: session.id, kind: 'turn' });
  expect(proactive.mock.calls.some(([message]) => message.text === getDelegationJob(job!.publicId)?.result_text)).toBe(false);
});
