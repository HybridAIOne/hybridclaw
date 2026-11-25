import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-trigger-tool-',
});

async function load() {
  setupHome();
  vi.doMock('../src/scheduler/scheduler.js', () => ({ rearmScheduler: vi.fn() }));
  const { initDatabase, getOrCreateSession } = await import('../src/memory/db.ts');
  const { getAllJobs } = await import('../src/memory/jobs.ts');
  const { runTriggerToolAction } = await import(
    '../src/gateway/trigger-tool-service.ts'
  );
  initDatabase({ quiet: true });
  return { getAllJobs, getOrCreateSession, runTriggerToolAction };
}

function statusOf(run: () => unknown): number | undefined {
  try {
    run();
  } catch (error) {
    return (error as { statusCode?: number }).statusCode;
  }
  return undefined;
}

test('a trigger reaches only the Teams conversation that created it', async () => {
  const { getAllJobs, getOrCreateSession, runTriggerToolAction } = await load();
  const teams = getOrCreateSession('teams-session-1', null, 'a:personal-chat');
  const discord = getOrCreateSession('discord-session-1', null, '123456789012345678');
  const request = { action: 'add', on: 'webhook', prompt: 'Summarize it.' };

  for (const [sessionId, channelId] of [
    [teams.id, '19:other-chat@thread.v2'],
    [discord.id, 'a:personal-chat'],
  ]) {
    expect(
      statusOf(() => runTriggerToolAction({ ...request, sessionId, channelId })),
    ).toBe(403);
  }
  expect(getAllJobs({ kind: 'scheduled_task' })).toHaveLength(0);

  runTriggerToolAction({ ...request, sessionId: teams.id });
  expect(getAllJobs({ kind: 'scheduled_task' })).toEqual([
    expect.objectContaining({ channel_id: 'a:personal-chat' }),
  ]);
});
