import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runContainerAgent = useContainerAgentHarness();

function bashCall(id: string, command: string) {
  return {
    id,
    type: 'function',
    function: { name: 'bash', arguments: JSON.stringify({ command }) },
  };
}

test('a relative write after an earlier call moved the shell out lands in the workspace', async () => {
  let workspace = '';
  const { output } = await runContainerAgent(
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          bashCall('leave', 'cd /'),
          bashCall('write', 'echo note > notes.txt'),
        ],
      },
    ],
    { persistBashState: true },
    {},
    {
      prepare: async (dir) => {
        workspace = dir;
        return {};
      },
    },
  );

  expect(
    output.toolExecutions?.map((entry) => entry.approvalActionKey),
  ).toEqual(['bash:read-only', 'bash:write-op']);
  expect(output.pendingApproval).toBeFalsy();
  expect(fs.readFileSync(path.join(workspace, 'notes.txt'), 'utf-8')).toBe(
    'note\n',
  );
});
