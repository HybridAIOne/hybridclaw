import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { useCleanMocks } from './test-utils.js';
const run = useContainerAgentHarness();
useCleanMocks({ cleanup: cleanupGatewayRuntime });

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
      return { role: 'assistant', content: null, tool_calls: [{ id: 'run-script', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'bash ./task.sh', description: 'Run the prepared task and save its result in the working folder.' }) } }] };
    }
    return { role: 'assistant', content: 'Completed.' };
  }, {
    approvalUserId: 'user-a', approvalUserText: 'Run the prepared script.',
    messages: [{ role: 'user', content: 'Run the prepared script.' }],
  }, { 'task.sh': 'echo executed >> executions.txt\n' });
  expect(worker.output.pendingApproval?.approvalId).toBeTruthy();
  expect(worker.output.pendingApproval?.intent).toBe('Run the prepared task and save its result in the working folder.');
  expect(JSON.parse(worker.output.toolExecutions?.[0].arguments || '{}')).toEqual({ command: 'bash ./task.sh' });
  expect(fs.existsSync(path.join(worker.dir, 'executions.txt'))).toBe(false);
  const approved = await worker.followup({
    approvalUserText: 'Ja, führe das Skript aus.',
    messages: [{ role: 'user', content: 'A voice model paraphrase should not supply approval.' }],
  });
  expect(approved.status).toBe('success');
  expect(approved.pendingApproval).toBeUndefined();
  expect(approved.toolExecutions?.filter(item => item.name === 'bash')).toHaveLength(1);
  expect(JSON.parse(approved.toolExecutions?.[0].arguments || '{}')).toEqual({ command: 'bash ./task.sh' });
  expect(fs.readFileSync(path.join(worker.dir, 'executions.txt'), 'utf8')).toBe('executed\n');
  expect(interpretations).toBe(1);
  expect(approved.tokenUsage?.modelCalls).toBeGreaterThanOrEqual(2);
  const { initDatabase, getRecentStructuredAuditForSession } = await import('../src/memory/db.js');
  const { emitToolExecutionAuditEvents } = await import('../src/audit/audit-events.js');
  const { flushAuditTrail } = await import('../src/audit/audit-trail.js');
  initDatabase({ quiet: true });
  for (const [index, output] of [worker.output, approved].entries()) {
    emitToolExecutionAuditEvents({ sessionId: 'description-audit', runId: `run-${index}`, toolExecutions: output.toolExecutions });
  }
  await flushAuditTrail();
  const calls = getRecentStructuredAuditForSession('description-audit', 30).filter(event => event.event_type === 'tool.call');
  expect(calls).toHaveLength(2);
  for (const event of calls) expect(JSON.parse(event.payload).arguments).toEqual({ command: 'bash ./task.sh' });
  await worker.followup({ approvalUserText: 'Danke.', messages: [{ role: 'user', content: 'Danke.' }] });
  expect(fs.readFileSync(path.join(worker.dir, 'executions.txt'), 'utf8')).toBe('executed\n');
});

test('an automatic shell call executes without display metadata while its original model history is retained', async () => {
  let first = true;
  let historyArguments: string | undefined;
  const args = { command: 'pwd', description: 'Show the working folder.' };
  const worker = await run(async body => {
    if (first) {
      first = false;
      return { role: 'assistant', content: null, tool_calls: [{ id: 'show-folder', type: 'function', function: { name: 'bash', arguments: JSON.stringify(args) } }] };
    }
    historyArguments = body.messages?.find(message => message.role === 'assistant' && message.tool_calls?.length)?.tool_calls?.[0].function.arguments;
    return { role: 'assistant', content: 'Done.' };
  });
  expect(worker.output.pendingApproval).toBeUndefined();
  expect(JSON.parse(worker.output.toolExecutions?.[0].arguments || '{}')).toEqual({ command: 'pwd' });
  expect(JSON.parse(historyArguments || '{}')).toEqual(args);
});
