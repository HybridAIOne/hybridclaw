import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const run = useContainerAgentHarness();
const cutOff = { role: 'assistant', content: '<think>Unfinished calculation', finish_reason: 'length' };
const call = (name: string, args: Record<string, unknown>) => ({
  role: 'assistant', content: null, tool_calls: [{
    id: `call_${name}`, type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }],
});

test('a bounded continuation preserves successful writes and their results without replaying them', async () => {
  const worker = await run([
    call('write', { path: 'ledger.txt', contents: 'entry recorded' }),
    cutOff,
    call('read', { path: 'ledger.txt' }),
    { role: 'assistant', content: 'The ledger entry is verified.' },
  ], { allowedTools: ['write', 'read'], approvalMode: 'full' });
  expect(worker.output.status).toBe('success');
  expect(worker.requests).toHaveLength(4);
  const before = worker.requests[1];
  const recovery = worker.requests[2];
  expect(recovery.messages.slice(0, before.messages.length)).toEqual(before.messages);
  expect(recovery.tools).toEqual(before.tools);
  expect(recovery.messages.at(-1)?.role).toBe('user');
  expect(worker.output.toolExecutions?.map((execution) => execution.name)).toEqual(['write', 'read']);
  expect(worker.output.toolExecutions?.every((execution) => !execution.isError)).toBe(true);
  expect(fs.readFileSync(path.join(worker.dir, 'ledger.txt'), 'utf8')).toBe('entry recorded');
  expect(worker.output.result).toBe('The ledger entry is verified.');
});

test('repeated output exhaustion fails with accounted usage and no unfinished answer', async () => {
  const worker = await run([cutOff, cutOff, { role: 'assistant', content: 'Must not be reached.' }]);
  expect(worker.requests).toHaveLength(2);
  expect(worker.output.status).toBe('error');
  expect(worker.output.result).toBeNull();
  expect(worker.output.error).toContain('output-token limit');
  expect(worker.output.tokenUsage).toBeDefined();
  expect(worker.output.toolExecutions).toHaveLength(0);
});

test('successful tool progress does not replenish the recovery budget', async () => {
  const worker = await run([
    cutOff,
    call('read', { path: 'ledger.txt' }),
    cutOff,
  ], { allowedTools: ['read'] }, { 'ledger.txt': 'one entry' });
  expect(worker.requests).toHaveLength(3);
  expect(worker.output.status).toBe('error');
  expect(worker.output.toolExecutions).toHaveLength(1);
});

test('an empty local stop is still an error rather than fabricated completion', async () => {
  const worker = await run([{ role: 'assistant', content: null, finish_reason: 'stop' }]);
  expect(worker.requests).toHaveLength(1);
  expect(worker.output.status).toBe('error');
  expect(worker.output.result).toBeNull();
});

const qwenInput = {
  provider: 'vllm' as const,
  model: 'vllm/synthetic-qwen',
  modelBehavior: { thinkingFormat: 'qwen' as const },
  reasoningEffort: 'medium' as const,
  maxTokens: 256,
  allowedTools: ['read', 'write'],
  approvalMode: 'full' as const,
};

test('Qwen recovery disables thinking for the remaining turn without changing its token cap', async () => {
  const worker = await run([
    cutOff,
    call('read', { path: 'note.txt' }),
    { role: 'assistant', content: 'Verified.' },
    { role: 'assistant', content: 'Fresh turn.' },
  ], qwenInput, { 'note.txt': 'recorded' });
  expect(worker.output.status).toBe('success');
  expect(worker.requests[0].chat_template_kwargs).toBeUndefined();
  for (const request of worker.requests.slice(1)) {
    expect(request.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(request.max_tokens).toBe(256);
  }
  expect(worker.requests[1].messages.slice(0, worker.requests[0].messages.length)).toEqual(worker.requests[0].messages);
  expect(worker.requests[1].tools).toEqual(worker.requests[0].tools);
  const next = await worker.followup({ messages: [{ role: 'user', content: 'Start another task.' }] });
  expect(next.status).toBe('success');
  expect(worker.requests.at(-1)?.chat_template_kwargs).toBeUndefined();
});

test('a truncated malformed tool batch also disables thinking before its bounded correction', async () => {
  const worker = await run([
    { role: 'assistant', content: null, finish_reason: 'length', tool_calls: [{
      id: 'broken', type: 'function', function: { name: 'write', arguments: '{"path":' },
    }] },
    call('read', { path: 'note.txt' }),
    { role: 'assistant', content: 'Verified.' },
  ], qwenInput, { 'note.txt': 'recorded' });
  expect(worker.output.status).toBe('success');
  expect(worker.requests[1].chat_template_kwargs).toEqual({ enable_thinking: false });
  expect(worker.output.toolExecutions?.filter((execution) => !execution.isError).map((execution) => execution.name)).toEqual(['read']);
  expect(worker.output.toolExecutions?.find((execution) => execution.name === 'write')?.isError).toBe(true);
  expect(fs.readFileSync(path.join(worker.dir, 'note.txt'), 'utf8')).toBe('recorded');
});
