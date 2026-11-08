import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const run = useContainerAgentHarness();
function response(tool: string, args: Record<string, unknown>) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'test-call',
        type: 'function',
        function: { name: tool, arguments: JSON.stringify(args) },
      },
    ],
  };
}

test('learning executes a pinned read and carries its observation through IPC', async () => {
  const worker = await run(
    [
      response('read', { path: '.env' }),
      { role: 'assistant', content: 'Inspected.' },
    ],
    { approvalMode: 'learning' },
    { '.env': 'SAMPLE=test-value' },
  );
  expect(worker.output.pendingApproval).toBeUndefined();
  expect(worker.output.toolExecutions?.[0]).toMatchObject({
    name: 'read',
    blocked: false,
    isError: false,
    approvalDecision: 'auto',
    approvalObservation: { decision: 'required', pinned: true, tier: 'red' },
  });
});

test('learning does not bypass the unconditional shell safety guard', async () => {
  const worker = await run(
    [
      response('bash', { command: 'rm -f preserve.txt' }),
      { role: 'assistant', content: 'Blocked.' },
    ],
    { approvalMode: 'learning' },
    { 'preserve.txt': 'keep' },
  );
  expect(fs.readFileSync(path.join(worker.dir, 'preserve.txt'), 'utf8')).toBe(
    'keep',
  );
  expect(worker.output.pendingApproval).toBeUndefined();
  expect(worker.output.toolExecutions?.[0].isError).toBe(true);
});

test('switching to learning does not interpret the next task as an answer to an old prompt', async () => {
  const worker = await run(
    [
      response('read', { path: '.env' }),
      response('read', { path: '.env' }),
      { role: 'assistant', content: 'Inspected in learning mode.' },
    ],
    { approvalMode: 'auto', approvalUserText: 'Inspect the configuration.' },
    { '.env': 'SAMPLE=test-value' },
  );
  expect(worker.output.pendingApproval).toBeDefined();
  const next = await worker.followup({
    approvalMode: 'learning',
    approvalUserText: 'Inspect the configuration.',
    messages: [{ role: 'user', content: 'Inspect the configuration.' }],
  });
  expect(next.pendingApproval).toBeUndefined();
  expect(next.approvalReply).toBeUndefined();
  expect(next.toolExecutions?.[0].approvalObservation?.decision).toBe(
    'required',
  );
});
