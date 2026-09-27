import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempHome = useTempDir('hybridclaw-approval-mode-');

useCleanMocks({
  restoreAllMocks: true,
  unstubAllEnvs: true,
  resetModules: true,
});

async function setup(sessionId: string) {
  vi.stubEnv('HOME', makeTempHome());
  vi.resetModules();
  const db = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const gateway = await import('../src/gateway/gateway-service.ts');
  db.initDatabase({ quiet: true });
  memoryService.getOrCreateSession(sessionId, null, 'web');
  const run = (...args: string[]) =>
    gateway.handleGatewayCommand({
      sessionId,
      guildId: null,
      channelId: 'web',
      userId: 'user_a',
      args: ['approvals', ...args],
    });
  const effective = () =>
    gateway.getGatewaySessionContextUsage(sessionId).approvalMode;
  return { db, memoryService, run, effective };
}

test('approvals mode defaults to auto and persists a change with an audit record', async () => {
  const { db, memoryService, run, effective } = await setup('s-mode');

  expect((await run('mode')).text).toContain('Current: auto');
  expect(effective()).toBe('auto');

  const updated = await run('mode', 'ask');
  expect(updated.kind).toBe('info');
  expect(memoryService.getSessionById('s-mode')?.approval_mode).toBe('ask');
  expect(effective()).toBe('ask');

  const audit = db
    .getRecentStructuredAuditForSession('s-mode')
    .filter((entry) => entry.event_type === 'approval.mode_changed');
  expect(audit).toHaveLength(1);
  expect(JSON.parse(audit[0].payload)).toMatchObject({
    from: 'auto',
    to: 'ask',
    user_id: 'user_a',
  });
});

test.each([
  [['mode', 'yolo']],
  [['list']],
  [[]],
])('approvals %j is rejected without changing the mode', async (args) => {
  const { memoryService, run } = await setup('s-bad');
  expect((await run(...args)).kind).toBe('error');
  expect(memoryService.getSessionById('s-bad')?.approval_mode).toBe('auto');
});

test('a running full-auto loop forces full access regardless of the stored mode', async () => {
  const { db, run, effective } = await setup('s-loop');
  await run('mode', 'ask');
  db.updateSessionFullAuto('s-loop', { enabled: true });

  expect(effective()).toBe('full');
  expect((await run('mode')).text).toContain('/fullauto off');
});
