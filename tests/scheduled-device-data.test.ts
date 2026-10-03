import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));
vi.mock('../src/agent/agent.js', () => ({ runAgent: runAgentMock }));
const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hy-scheduled-device-',
  cleanup: () => { runAgentMock.mockReset(); },
});

async function load() {
  setupHome();
  const db = await import('../src/memory/db.ts');
  const jobs = await import('../src/memory/jobs.ts');
  const device = await import('../src/gateway/device-data.ts');
  const runner = await import('../src/scheduler/scheduled-task-runner.ts');
  const scheduler = await import('../src/scheduler/scheduler.ts');
  db.initDatabase({ quiet: true });
  const session = db.getOrCreateSession('app-owned', null, 'web', 'main');
  device.writeDeviceSources('alice', { calendar: 'Calendar\n- Alice meeting' });
  device.writeDeviceSources('bob', { calendar: 'Calendar\n- Bob private meeting' });
  const create = (ownerUserId?: string) => jobs.createJob({
    kind: 'scheduled_task', sessionId: session.id, channelId: 'web',
    cronExpr: '*/30 * * * *', prompt: 'Prepare a brief', ownerUserId,
  });
  const run = (taskId: number, prompt = 'Prepare a brief', agentId = 'main') => runner.runIsolatedScheduledTask({
    taskId, prompt, agentId, channelId: 'web', chatbotId: 'test', model: 'gpt-4o-mini',
    sessionId: 'scheduled-test',
      taskOwner: { userId: 'alice', sessionId: session.id }, onResult: vi.fn(), onError: vi.fn(),
  });
  return { jobs, device, scheduler, create, run, session };
}

test('a real wrapped scheduled dispatch reads only its owner and cleans up', async () => {
  const { device, scheduler, create, run } = await load();
  const id = create('alice');
  runAgentMock.mockImplementation(async (input) => {
    expect(input.blockedTools).not.toContain('device_data');
    const data = device.renderDeviceDataForSession(input.sessionId, null);
    expect(data).toContain('Alice meeting');
    expect(data).not.toContain('Bob private');
    return { status: 'success', result: 'NO_REPLY', toolExecutions: [] };
  });
  await run(id, scheduler.wrapCronPrompt(scheduler.dbTaskLabel(id), 'Prepare a brief', 'UTC', 'web'));
  expect(runAgentMock).toHaveBeenCalledOnce();
  expect(device.renderDeviceDataForSession('scheduled-test', null)).not.toContain('Alice meeting');
});

test('missing ownership, wrong agent, changed prompt and revoked sharing fail closed', async () => {
  const { device, create, run } = await load();
  runAgentMock.mockImplementation(async (input) => {
    expect(input.blockedTools).toContain('device_data');
    expect(device.renderDeviceDataForSession(input.sessionId, null)).not.toContain('Alice meeting');
    return { status: 'success', result: 'NO_REPLY', toolExecutions: [] };
  });
  await run(create());
  const id = create('alice');
  await run(id, 'Prepare a brief', 'other-agent');
  await run(id, 'Old prompt');
  device.clearDeviceSources('alice');
  await run(id);
});

test('device access is released when the model throws', async () => {
  const { device, create, run } = await load();
  runAgentMock.mockImplementation(async (input) => {
    expect(device.renderDeviceDataForSession(input.sessionId, null)).toContain('Alice meeting');
    throw new Error('model failed');
  });
  await run(create('alice'));
  expect(device.renderDeviceDataForSession('scheduled-test', null)).not.toContain('Alice meeting');
});

test('scheduled reads withhold old and future entries, foreground reads retain timestamps', async () => {
  const { device } = await load();
  const now = new Date('2026-10-03T12:00:00Z');
  vi.spyOn(Date, 'now').mockReturnValue(now.getTime());
  device.writeDeviceSources('alice', { calendar: 'Calendar\n- Old meeting' }, () => new Date(now.getTime() - 86400001));
  device.writeDeviceSources('alice', { reminders: 'Reminders\n- Current task' }, () => new Date(now.getTime() - 86400000));
  device.writeDeviceSources('alice', { health: 'Health\n- Future measurement' }, () => new Date(now.getTime() + 1));
  const end = device.beginDeviceDataTurn('background', 'alice', 86400000);
  const data = device.renderDeviceDataForSession('background', null);
  expect(data).toContain('Current task');
  expect(data).toContain('open Hy');
  expect(data).not.toContain('Old meeting');
  expect(data).not.toContain('Future measurement');
  end();
  const foreground = device.beginDeviceDataTurn('foreground', 'alice');
  expect(device.renderDeviceDataForSession('foreground', 'calendar')).toContain('Old meeting');
  foreground();
});

test('a job created during a verified turn persists ownership after the turn', async () => {
  const { jobs, device, create, session } = await load();
  const end = device.beginDeviceDataTurn(session.id, 'alice');
  const id = create();
  end();
  jobs.updateScheduledTask(id, { cronExpr: '0 10 * * *', prompt: 'Changed brief', channelId: 'web' });
  expect(jobs.getJob(id, { kind: 'scheduled_task' })?.owner_user_id).toBe('alice');
});

test('signed-in schedule and goal commands bind their owner', async () => {
  const { jobs, session } = await load();
  const { handleGatewayCommand } = await import('../src/gateway/gateway-service.ts');
  for (const args of [
    ['schedule', 'add', '"0 9 * * *"', 'Read my calendar'],
    ['track', 'add', '--kind', 'goal', '--every', 'daily', 'Prepare meeting'],
  ]) {
    const result = await handleGatewayCommand({ sessionId: session.id, channelId: 'web', guildId: null, userId: 'alice', args });
    expect(result.kind, result.text).not.toBe('error');
  }
  const tasks = jobs.getAllJobs({ kind: 'scheduled_task' });
  expect(tasks).toHaveLength(2);
  expect(tasks.every((task) => task.owner_user_id === 'alice')).toBe(true);
});

 test('an anonymous nested turn cannot inherit device access', async () => {
  const { device } = await load();
  const end = device.beginDeviceDataTurn('nested', 'alice');
  const anonymous = device.beginDeviceDataTurn('nested', null);
  expect(device.renderDeviceDataForSession('nested', null)).not.toContain('Alice meeting');
  anonymous();
  expect(device.renderDeviceDataForSession('nested', null)).toContain('Alice meeting');
  end();
});

 test('an old dispatch cannot inherit the owner of a reused task ID', async () => {
  const { jobs, device, create, run } = await load();
  const oldId = create('alice');
  jobs.deleteJob(oldId);
  const replacement = create('bob');
  expect(replacement).toBe(oldId);
  runAgentMock.mockImplementation(async (input) => {
    expect(input.blockedTools).toContain('device_data');
    expect(device.renderDeviceDataForSession(input.sessionId, null)).not.toContain('Bob private');
    return { status: 'success', result: 'NO_REPLY', toolExecutions: [] };
  });
  await run(oldId);
});

test('overlapping users fail closed and out-of-order cleanup leaves no old grant', async () => {
  const { device } = await load();
  const alice = device.beginDeviceDataTurn('overlap', 'alice');
  const bob = device.beginDeviceDataTurn('overlap', 'bob');
  expect(device.renderDeviceDataForSession('overlap', null)).toContain('shares nothing');
  alice();
  expect(device.renderDeviceDataForSession('overlap', null)).toContain('Bob private');
  bob();
  expect(device.renderDeviceDataForSession('overlap', null)).toContain('shares nothing');
});
