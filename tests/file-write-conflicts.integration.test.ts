import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();
function call(id: string, name: string, args: Record<string, unknown>) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

test('the real dispatcher stops a shell overwrite after failed replacement preconditions', async () => {
  const run = await runAgent(
    [
      call('write-1', 'write', { path: 'report.md', contents: 'Replacement' }),
      call('write-2', 'write', {
        path: 'report.md',
        contents: 'Replacement',
        overwrite: true,
        expected_content: 'Stale',
      }),
      call('shell-1', 'bash', {
        command: "cat > report.md <<'EOF'\nReplacement\nEOF",
      }),
    ],
    { approvalMode: 'full' },
    { 'report.md': 'Original work\n' },
  );
  expect(run.output.pendingApproval).toMatchObject({
    toolName: 'bash',
    allowSession: false,
    allowAgent: false,
    allowAll: false,
  });
  expect(run.output.pendingApproval?.reason).toContain(
    JSON.stringify(path.join(fs.realpathSync(run.dir), 'report.md')),
  );
  expect(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8')).toBe(
    'Original work\n',
  );
}, 20000);

test('the real dispatcher allows diagnostic fallback before a separate deliverable', async () => {
  const run = await runAgent(
    [
      call('write-1', 'write', { path: 'report.md', contents: 'Replacement' }),
      call('diagnose', 'bash', {
        command: 'ls -la report.md 2>&1 || echo absent',
      }),
      call('write-2', 'write', {
        path: 'report-new.md',
        contents: 'New deliverable',
      }),
    ],
    { approvalMode: 'full' },
    { 'report.md': 'Original work\n' },
  );
  expect(run.output.pendingApproval).toBeUndefined();
  expect(run.output.status).toBe('success');
  expect(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8')).toBe(
    'Original work\n',
  );
  expect(fs.readFileSync(path.join(run.dir, 'report-new.md'), 'utf8')).toBe(
    'New deliverable',
  );
}, 20000);

test('one-time approval still executes a fenced script and a later run needs a new approval', async () => {
  const command = 'bash ./generate.sh';
  const replies: Array<Record<string, unknown>> = [
    call('failed-write', 'write', { path: 'report.md', contents: 'Replacement' }),
    call('first-script', 'bash', { command }),
    { role: 'assistant', content: 'Generated the output.' },
    call('second-script', 'bash', { command }),
  ];
  let interpretations = 0;
  const run = await runAgent(async (body) => {
    const message = body.messages?.at(-1);
    if (typeof message?.content === 'string') {
      let input: { pending?: Array<{ approvalId: string }>; userReply?: string } = {};
      try { input = JSON.parse(message.content); } catch {}
      if (input.pending) {
        interpretations += 1;
        expect(input.userReply).toBe('yes');
        expect(body.tools ?? []).toEqual([]);
        return { role: 'assistant', content: JSON.stringify({ decision: 'approve', approvalId: input.pending[0].approvalId, scope: 'once', reply: '' }) };
      }
    }
    return replies.shift() ?? { role: 'assistant', content: 'done' };
  }, {
    approvalMode: 'full', approvalUserId: 'user_a', approvalUserText: 'Generate a new output from the prepared script.',
  }, {
    'report.md': 'Original work\n',
    'generate.sh': "printf 'generated\\n' >> generated.log\n",
  });
  expect(run.output.pendingApproval).toMatchObject({ toolName: 'bash', allowSession: false, allowAgent: false, allowAll: false });
  expect(fs.existsSync(path.join(run.dir, 'generated.log'))).toBe(false);
  const approved = await run.followup({ approvalUserText: 'yes', messages: [{ role: 'user', content: 'yes' }] });
  expect(approved.status).toBe('success');
  expect(approved.pendingApproval).toBeUndefined();
  expect(interpretations).toBe(1);
  expect(fs.readFileSync(path.join(run.dir, 'generated.log'), 'utf8')).toBe('generated\n');
  const again = await run.followup({ approvalUserText: 'Run it again.', messages: [{ role: 'user', content: 'Run it again.' }] });
  expect(again.pendingApproval?.approvalId).toBeTruthy();
  expect(again.pendingApproval?.approvalId).not.toBe(run.output.pendingApproval?.approvalId);
  expect(fs.readFileSync(path.join(run.dir, 'generated.log'), 'utf8')).toBe('generated\n');
  expect(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8')).toBe('Original work\n');
}, 20000);
