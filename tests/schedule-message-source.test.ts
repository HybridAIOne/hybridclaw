import { afterEach, expect, test, vi } from 'vitest';
import { useTempDir } from './test-utils.js';
const makeHome = useTempDir('hy-schedule-source-');
let close: (() => void) | undefined;
afterEach(() => { close?.(); vi.unstubAllEnvs(); vi.resetModules(); });
const runAgent = vi.hoisted(() => vi.fn(async (_input: unknown) => ({status: 'success', result: 'Update', toolExecutions: []})));
vi.mock('../src/agent/agent.js', () => ({runAgent}));

test('same-chat runs keep their schedule origin and pass the requested effort to the model', async () => {
  vi.stubEnv('HOME', makeHome());
  const db = await import('../src/memory/db.js');
  const jobs = await import('../src/memory/jobs.js');
  const runner = await import('../src/scheduler/scheduled-task-runner.js');
  db.initDatabase({quiet: true}); close = db.closeDatabase;
  const session = db.getOrCreateSession('chat-a', null, 'web', 'main');
  const id = jobs.createJob({kind: 'scheduled_task', sessionId: session.id, channelId: 'web', cronExpr: '0 * * * *', prompt: 'Check'});
  const result = vi.fn(); const error = vi.fn();
  await runner.runIsolatedScheduledTask({taskId: id, prompt: 'Check', channelId: 'web', chatbotId: 'test', model: 'hybridai/qwen/qwen3.8-27b', reasoningEffort: 'medium', agentId: 'main', sessionId: session.id, onResult: result, onError: error});
  expect(error).not.toHaveBeenCalled();
  expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({reasoningEffort: 'medium'}));
  const message = result.mock.calls[0][0].storedMessage;
  expect(db.getSessionAssistantMessage(session.id, message.id)?.source).toBe(`schedule:${id}`);
});
