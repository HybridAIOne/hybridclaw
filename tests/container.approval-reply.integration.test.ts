import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';
const run = useContainerAgentHarness();

test('a natural reply crosses authenticated IPC and replays the exact pending call once', async () => {
  let first = true;
  let interpretations = 0;
  const worker = await run(async body => {
    const message = body.messages?.at(-1);
    if (typeof message?.content === 'string') {
      let input: { pending?: Array<{ approvalId: string }>; userReply?: string } = {};
      try { input = JSON.parse(message.content); } catch {}
      if (input.pending) {
        interpretations += 1;
        expect(input.userReply).toBe('Ja, führe das Skript aus.');
        expect(body.tools ?? []).toEqual([]);
        return { role: 'assistant', content: JSON.stringify({ decision: 'approve', approvalId: input.pending[0].approvalId, scope: 'once', reply: '' }) };
      }
    }
    if (first) {
      first = false;
      return { role: 'assistant', content: null, tool_calls: [{ id: 'run-script', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'bash ./task.sh' }) } }] };
    }
    return { role: 'assistant', content: 'Completed.' };
  }, {
    approvalUserId: 'user-a', approvalUserText: 'Run the prepared script.',
    messages: [{ role: 'user', content: 'Run the prepared script.' }],
  }, { 'task.sh': 'echo executed >> executions.txt\n' });
  expect(worker.output.pendingApproval?.approvalId).toBeTruthy();
  expect(fs.existsSync(path.join(worker.dir, 'executions.txt'))).toBe(false);
  const approved = await worker.followup({
    approvalUserText: 'Ja, führe das Skript aus.',
    messages: [{ role: 'user', content: 'A voice model paraphrase should not supply approval.' }],
  });
  expect(approved.status).toBe('success');
  expect(approved.pendingApproval).toBeUndefined();
  expect(approved.toolExecutions?.filter(item => item.name === 'bash')).toHaveLength(1);
  expect(fs.readFileSync(path.join(worker.dir, 'executions.txt'), 'utf8')).toBe('executed\n');
  expect(interpretations).toBe(1);
  expect(approved.tokenUsage?.modelCalls).toBeGreaterThanOrEqual(2);
  await worker.followup({ approvalUserText: 'Danke.', messages: [{ role: 'user', content: 'Danke.' }] });
  expect(fs.readFileSync(path.join(worker.dir, 'executions.txt'), 'utf8')).toBe('executed\n');
});
