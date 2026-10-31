import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';
const run = useContainerAgentHarness();
const call = () => ({
  role: 'assistant',
  content: null,
  tool_calls: [
    {
      id: 'call-1',
      type: 'function',
      function: {
        name: 'bash',
        arguments: JSON.stringify({ command: 'eval "printf safe"' }),
      },
    },
  ],
});

test('a surviving worker applies authenticated settings each turn and missing settings restore defaults', async () => {
  const worker = await run(
    [
      call(),
      { role: 'assistant', content: 'Done.' },
      call(),
      { role: 'assistant', content: 'Blocked.' },
    ],
    { approvalMode: 'full', disabledSafetyRules: ['eval'] },
  );
  expect(worker.output.pendingApproval).toBeUndefined();
  expect(worker.output.toolExecutions?.[0]).toMatchObject({
    name: 'bash',
    isError: false,
  });
  const next = await worker.followup({
    disabledSafetyRules: undefined,
    messages: [{ role: 'user', content: 'Repeat the command.' }],
  });
  expect(next.toolExecutions?.[0]).toMatchObject({
    name: 'bash',
    blocked: true,
    approvalDecision: 'denied',
  });
  expect(next.pendingApproval).toBeUndefined();
});
