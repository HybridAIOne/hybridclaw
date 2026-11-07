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

test('authenticated worker inputs preserve a family conflict and allow checked recovery', async () => {
  const replies = [
    call('reject', 'write', { path: 'report.md', contents: 'Replacement' }),
    call('child-shell', 'bash', { command: 'printf changed > report.md' }),
    call('parent-shell', 'bash', { command: 'printf changed > report.md' }),
    call('checked', 'write', { path: 'report.md', contents: 'Revised', overwrite: true, expected_content: 'Original\n' }),
    call('restored', 'bash', { command: 'printf completed > completion.txt' }),
    { role: 'assistant', content: 'Completed.' },
  ];
  const run = await runAgent(replies, { sessionId: 'child', fileWriteGuardSessionId: 'parent', approvalMode: 'full' }, { 'report.md': 'Original\n' });
  expect(run.output.pendingApproval?.toolName).toBe('bash');
  expect(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8')).toBe('Original\n');
  const parent = await run.followup({ sessionId: 'parent', fileWriteGuardSessionId: undefined, messages: [{ role: 'user', content: 'Continue.' }] });
  expect(parent.pendingApproval?.toolName).toBe('bash');
  expect(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8')).toBe('Original\n');
  const sibling = await run.followup({ sessionId: 'sibling', fileWriteGuardSessionId: 'parent', messages: [{ role: 'user', content: 'Apply a checked replacement.' }] });
  expect(sibling.status).toBe('success');
  expect(sibling.pendingApproval).toBeUndefined();
  expect(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8')).toBe('Revised');
  expect(fs.readFileSync(path.join(run.dir, 'completion.txt'), 'utf8')).toBe('completed');
}, 20000);

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

test.each([
  'ls -la report.md 2>&1 || echo absent',
  'date -u +%s',
])('the real dispatcher allows diagnostic %s before a separate deliverable', async (command) => {
  const run = await runAgent(
    [
      call('write-1', 'write', { path: 'report.md', contents: 'Replacement' }),
      call('diagnose', 'bash', {
        command,
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

test('the first rejected write exposes recovery and a checked replacement restores shell execution', async () => {
  const original = 'Original work\n';
  let step = 0;
  const run = await runAgent(async (body) => {
    const last = body.messages.at(-1);
    switch (step++) {
      case 0:
        return call('create', 'write', { path: 'report.md', contents: 'Revised\n' });
      case 1:
        expect(last).toMatchObject({ role: 'tool', tool_call_id: 'create' });
        expect(last?.content).toContain('report.md');
        expect(last?.content).toContain('one-time approval');
        expect(last?.content).not.toContain(original);
        return call('inspect', 'read', { path: 'report.md' });
      case 2:
        expect(last).toMatchObject({ role: 'tool', tool_call_id: 'inspect' });
        expect(last?.content).toContain('Original work');
        return call('replace', 'write', {
          path: 'report.md', contents: 'Revised\n', overwrite: true,
          expected_content: original,
        });
      case 3:
        return call('continue', 'bash', { command: "printf completed > completion.txt" });
      default:
        return { role: 'assistant', content: 'Completed.' };
    }
  }, { approvalMode: 'full' }, { 'report.md': original });
  expect(run.output.pendingApproval).toBeUndefined();
  expect(run.output.status).toBe('success');
  expect(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8')).toBe('Revised\n');
  expect(fs.readFileSync(path.join(run.dir, 'completion.txt'), 'utf8')).toBe('completed');
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
