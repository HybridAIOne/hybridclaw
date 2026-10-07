import { afterEach, expect, test, vi } from 'vitest';
import { useTempDir } from './test-utils.js';
const makeHome = useTempDir('hy-task-execution-');
let close: (() => void) | undefined;
afterEach(() => { close?.(); vi.unstubAllEnvs(); vi.resetModules(); vi.clearAllMocks(); });
const mocks = vi.hoisted(() => ({run: vi.fn()}));
vi.mock('../src/scheduler/scheduled-task-runner.js', () => ({runIsolatedScheduledTask: mocks.run}));
vi.mock('../src/gateway/gateway-service.js', () => ({
  prepareSessionAutoReset: vi.fn(async () => undefined),
  resolveSessionAutoResetPolicy: () => ({mode: 'none'}),
  resolveGatewayChatbotId: vi.fn(async () => ({chatbotId: 'test', source: 'session'})),
}));
vi.mock('../src/agents/agent-registry.js', () => ({resolveAgentForRequest: () => ({agentId: 'main', model: 'openai/gpt-4o', chatbotId: 'test'})}));

test('per-task model, effort and fresh sessions reach execution without changing the origin chat', async () => {
  vi.stubEnv('HOME', makeHome());
  const db = await import('../src/memory/db.js');
  const jobs = await import('../src/memory/jobs.js');
  const service = await import('../src/gateway/gateway-scheduled-task-service.js');
  db.initDatabase({quiet: true}); close = db.closeDatabase;
  const session = db.getOrCreateSession('chat-a', null, 'web', 'main');
  const id = jobs.createJob({kind: 'scheduled_task', sessionId: session.id, channelId: 'web', cronExpr: '0 * * * *', prompt: 'Check'});
  jobs.updateScheduledTask(id, {channelId: 'web', prompt: 'Check', cronExpr: '0 * * * *', model: 'hybridai/qwen/qwen3.8-27b', effort: 'medium', freshSession: true});
  for (let i = 0; i < 2; i++) await service.runGatewayScheduledTask(session.id, 'web', 'Check', id, vi.fn(), vi.fn(), `cron:${id}`);
  const [first, second] = mocks.run.mock.calls.map(call => call[0]);
  expect(first).toMatchObject({model: 'hybridai/qwen/qwen3.8-27b', reasoningEffort: 'medium', sessionId: undefined});
  expect(first.sessionKey).not.toBe(second.sessionKey);
  expect(db.getSessionById(session.id)?.model).toBe(session.model);
  jobs.updateScheduledTask(id, {channelId: 'web', prompt: 'Check', cronExpr: '0 * * * *', model: null, effort: null, freshSession: false});
  await service.runGatewayScheduledTask(session.id, 'web', 'Check', id, vi.fn(), vi.fn(), `cron:${id}`);
  expect(mocks.run.mock.calls[2][0]).toMatchObject({model: 'openai/gpt-4o', sessionId: session.id, reasoningEffort: undefined});
});
