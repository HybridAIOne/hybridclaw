import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));
vi.mock('../src/agent/agent.js', () => ({ runAgent: runAgentMock }));
vi.mock('../src/infra/host-runner.js', () => ({
  stopSessionHostProcess: vi.fn(),
}));
const runWorker = useContainerAgentHarness();
const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'delegation-policy-receipt-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

test('a real worker terminal refusal crosses the delegation boundary as blocked', async () => {
  const home = setupHome();
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true, dbPath: path.join(home, 'history.db') });
  db.getOrCreateSession('parent', null, 'web', 'main');
  const call = (id: string) => ({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id,
        type: 'function',
        function: {
          name: 'bash',
          arguments: JSON.stringify({
            command: 'echo generated > report.txt && rm -f rows.tmp.json',
          }),
        },
      },
    ],
  });
  const worker = await runWorker(
    [call('first-refusal'), call('second-refusal')],
    {},
    { 'rows.tmp.json': 'Preserve fixture.\n' },
  );
  expect(worker.output.status).toBe('success');
  expect(worker.output.pendingApproval).toBeUndefined();
  expect(worker.output.outputPresentation?.segmentKind).toBe('status');
  expect(worker.output.toolExecutions?.at(-1)).toMatchObject({
    blocked: true,
    approvalDecision: 'denied',
  });
  expect(fs.existsSync(path.join(worker.dir, 'report.txt'))).toBe(false);
  expect(fs.readFileSync(path.join(worker.dir, 'rows.tmp.json'), 'utf8')).toBe(
    'Preserve fixture.\n',
  );
  runAgentMock.mockResolvedValue(worker.output);
  const { runDelegationTaskWithRetry } = await import(
    '../src/gateway/delegation-child-run.js'
  );
  const report = await runDelegationTaskWithRetry({
    parentSessionId: 'parent',
    childDepth: 1,
    channelId: 'web',
    chatbotId: '',
    enableRag: false,
    agentId: 'main',
    mode: 'single',
    task: { prompt: 'Create a fixture report.', model: 'test-model' },
  });
  expect(report.status).toBe('blocked');
  expect(report.error).toBe(worker.output.result);
  expect(report.toolExecutions).toEqual(worker.output.toolExecutions);
  expect(report.result).toBeUndefined();
  expect(runAgentMock).toHaveBeenCalledOnce();
}, 20000);
