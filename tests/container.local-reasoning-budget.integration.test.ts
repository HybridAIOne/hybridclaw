import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const run = useContainerAgentHarness();
const reply = (name: string, args: Record<string, unknown>, tokens: number) => ({
  role: 'assistant', content: null,
  tool_calls: [{ id: `call_${name}_${tokens}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  usage: { prompt_tokens: 1000, completion_tokens: tokens, total_tokens: 1000 + tokens },
});

test.each([
  { isLocal: true, reasoningEffort: undefined, disabled: true },
  { isLocal: true, reasoningEffort: 'xhigh' as const, disabled: false },
  { isLocal: false, reasoningEffort: undefined, disabled: false },
])('only default local turns bound cumulative reasoning: %j', async ({ isLocal, reasoningEffort, disabled }) => {
  const worker = await run([
    reply('read', { path: 'first.txt' }, 5000),
    reply('read', { path: 'second.txt' }, 3500),
    reply('write', { path: 'receipt.txt', contents: 'one verified record' }, 100),
    { role: 'assistant', content: 'Saved.' },
    { role: 'assistant', content: 'Fresh turn.' },
  ], { provider: 'vllm', model: 'vllm/synthetic-qwen', modelBehavior: { thinkingFormat: 'qwen' }, isLocal, reasoningEffort, maxTokens: 8192, allowedTools: ['read', 'write'], approvalMode: 'full' }, { 'first.txt': 'first', 'second.txt': 'second' });
  expect(worker.output.status).toBe('success');
  expect(worker.requests).toHaveLength(4);
  expect(worker.requests[0].chat_template_kwargs).toBeUndefined();
  expect(worker.requests[1].chat_template_kwargs).toBeUndefined();
  for (const request of worker.requests.slice(2)) {
    expect(request.chat_template_kwargs).toEqual(disabled ? { enable_thinking: false } : undefined);
  }
  for (const request of worker.requests) {
    expect(request.max_tokens).toBe(8192);
    expect(request.tools).toEqual(worker.requests[0].tools);
  }
  expect(worker.requests[2].messages.slice(0, worker.requests[1].messages.length)).toEqual(worker.requests[1].messages);
  expect(worker.output.toolExecutions?.map(execution => execution.name)).toEqual(['read', 'read', 'write']);
  expect(fs.readFileSync(path.join(worker.dir, 'receipt.txt'), 'utf8')).toBe('one verified record');
  const next = await worker.followup({ messages: [{ role: 'user', content: 'Start another independent task.' }] });
  expect(next.status).toBe('success');
  expect(worker.requests).toHaveLength(5);
  expect(worker.requests.at(-1)?.chat_template_kwargs).toBeUndefined();
});
