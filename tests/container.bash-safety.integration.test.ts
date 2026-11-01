import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const run = useContainerAgentHarness();

function call(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

const blockedCommand = { command: 'echo generated > report.txt && rm -f rows.tmp.json' };

test('finishes permitted work without asking the user to manage optional blocked cleanup', async () => {
  const worker = await run([
    { role: 'assistant', content: null, tool_calls: [
      call('generate-and-clean', 'bash', blockedCommand),
      call('stale-sibling', 'write', { path: 'stale.txt', contents: 'must not run' }),
    ] },
    { role: 'assistant', content: null, tool_calls: [
      call('generate-only', 'write', { path: 'report.txt', contents: 'generated' }),
    ] },
    { role: 'assistant', content: 'Report ready: report.txt' },
  ], {}, { 'rows.tmp.json': 'preserve me' });
  expect(worker.output.pendingApproval).toBeUndefined();
  expect(worker.output.result).toBe('Report ready: report.txt');
  expect(fs.readFileSync(path.join(worker.dir, 'report.txt'), 'utf8')).toBe('generated');
  expect(fs.readFileSync(path.join(worker.dir, 'rows.tmp.json'), 'utf8')).toBe('preserve me');
  expect(fs.existsSync(path.join(worker.dir, 'stale.txt'))).toBe(false);
  expect(worker.output.toolExecutions?.map((entry) => entry.blocked === true)).toEqual([true, true, false]);
  const continuation = worker.requests[1].messages || [];
  expect(continuation.filter((message) => message.role === 'tool').map((message) => message.tool_call_id)).toEqual(['generate-and-clean', 'stale-sibling']);
});

test('a replan does not bypass a protected-file approval', async () => {
  const worker = await run([
    { role: 'assistant', content: null, tool_calls: [call('blocked', 'bash', blockedCommand)] },
    { role: 'assistant', content: null, tool_calls: [call('protected', 'read', { path: '.env' })] },
  ], { approvalMode: 'full' }, { '.env': 'TOKEN=test-key', 'rows.tmp.json': 'preserve me' });
  expect(worker.output.pendingApproval).toMatchObject({ toolName: 'read', allowSession: false });
  expect(worker.output.toolExecutions?.map((entry) => entry.approvalDecision)).toEqual(['denied', 'required']);
  expect(worker.output.result).not.toContain('TOKEN=test-key');
});

test('repeated hard blocks stop after one replan without executing the command', async () => {
  const worker = await run([
    { role: 'assistant', content: null, tool_calls: [call('first', 'bash', blockedCommand)] },
    { role: 'assistant', content: null, tool_calls: [call('second', 'bash', blockedCommand)] },
    { role: 'assistant', content: 'Must not reach this response.' },
  ], {}, { 'rows.tmp.json': 'preserve me' });
  expect(worker.requests).toHaveLength(2);
  expect(worker.output.pendingApproval).toBeUndefined();
  expect(worker.output.toolExecutions?.map((entry) => entry.approvalDecision)).toEqual(['denied', 'denied']);
  expect(fs.existsSync(path.join(worker.dir, 'report.txt'))).toBe(false);
  expect(fs.readFileSync(path.join(worker.dir, 'rows.tmp.json'), 'utf8')).toBe('preserve me');
});

test('the replan budget resets for the next request in the same worker', async () => {
  const blocked = { role: 'assistant', content: null, tool_calls: [call('blocked', 'bash', blockedCommand)] };
  const worker = await run([
    blocked,
    { role: 'assistant', content: 'First request finished.' },
    blocked,
    { role: 'assistant', content: 'Second request finished.' },
  ]);

  const next = await worker.followup({ messages: [{ role: 'user', content: 'Prepare another report.' }] });

  expect(worker.output.result).toBe('First request finished.');
  expect(next.result).toBe('Second request finished.');
  expect(next.pendingApproval).toBeUndefined();
  expect(next.toolExecutions).toHaveLength(1);
  expect(next.toolExecutions?.[0].approvalDecision).toBe('denied');
  expect(worker.requests).toHaveLength(4);
});

test.each(['auto', 'full'] as const)('hard-blocked cleanup never prompts or runs any part of a compound command (%s)', async (approvalMode) => {
  const worker = await run([
    { role: 'assistant', content: null, tool_calls: [{
      id: 'build-report', type: 'function', function: {
        name: 'bash',
        arguments: JSON.stringify({ command: 'echo generated > report.txt && rm -f rows.tmp.json' }),
      },
    }] },
  ], { approvalMode }, { 'rows.tmp.json': 'preserve me' });
  expect(worker.output.pendingApproval).toBeUndefined();
  expect(worker.output.toolExecutions).toHaveLength(1);
  expect(worker.output.toolExecutions?.[0]).toMatchObject({
    blocked: true, isError: true, approvalDecision: 'denied',
  });
  expect(fs.existsSync(path.join(worker.dir, 'report.txt'))).toBe(false);
  expect(fs.readFileSync(path.join(worker.dir, 'rows.tmp.json'), 'utf8')).toBe('preserve me');
});
