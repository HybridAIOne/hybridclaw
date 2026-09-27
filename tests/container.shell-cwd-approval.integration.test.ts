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

test('a relative write waits at the workspace fence after an earlier call moved the shell out', async () => {
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
  );

  expect(
    output.toolExecutions?.map((entry) => [
      entry.approvalActionKey,
      entry.approvalDecision,
    ]),
  ).toEqual([
    ['bash:other', 'implicit'],
    ['bash:workspace-fence', 'required'],
  ]);
  expect(output.pendingApproval?.intent).toContain('/notes.txt');
});
