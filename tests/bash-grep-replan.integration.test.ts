import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';
import { useTempDir } from './test-utils.js';

const run = useContainerAgentHarness();
const makeTempDir = useTempDir('grep-file-replan-');

function bashCall(id: string, command: string) {
  return {
    id,
    type: 'function' as const,
    function: { name: 'bash', arguments: JSON.stringify({ command }) },
  };
}

test('a compound grep denial allows a named-file retry without executing the original batch', async () => {
  const dir = fs.realpathSync(makeTempDir());
  const source = path.join(dir, 'model.py');
  fs.writeFileSync(source, 'parameter = 42\n');
  const worker = await run(
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [bashCall('combined', `echo ORIGINAL_PREFIX; grep -rn parameter ${dir}/*.py 2>/dev/null | head`)],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [bashCall('named-file', `grep -n -- parameter ${source}`)],
      },
      { role: 'assistant', content: 'Found the parameter.' },
    ],
    { approvalMode: 'full' },
  );

  expect(worker.output.pendingApproval).toBeUndefined();
  expect(worker.output.toolExecutions?.[0]).toMatchObject({
    approvalActionKey: 'bash:grep-file-search',
    approvalDecision: 'denied',
    blocked: true,
  });
  expect(worker.output.toolExecutions?.[1]?.result).toContain('parameter = 42');
  const recovery = worker.requests[1].messages?.find((message) => message.role === 'tool');
  expect(recovery?.content).toContain('grep -n');
  expect(recovery?.content).not.toContain('ORIGINAL_PREFIX');
});
