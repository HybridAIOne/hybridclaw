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

test('the worker delivers syntax feedback and accepts a correcting edit', async () => {
  const broken = '{"enabled":true,}';
  const repaired = '{"enabled":true}';
  const run = await runAgent([
    call('write', 'write', { path: 'settings.json', contents: broken }),
    call('edit', 'edit', { path: 'settings.json', old: broken, new: repaired }),
  ]);
  const messages = run.requests.at(-1)?.messages ?? [];
  expect(
    messages.find((message) => message.tool_call_id === 'write'),
  ).toMatchObject({
    role: 'tool',
    content: expect.stringMatching(/Warning:.*JSON/),
  });
  expect(
    messages.find((message) => message.tool_call_id === 'edit'),
  ).toMatchObject({
    role: 'tool',
    content: expect.stringMatching(/^Edited /),
  });
  expect(
    messages.find((message) => message.tool_call_id === 'edit')?.content,
  ).not.toContain('Warning:');
  expect(run.output.status).toBe('success');
  expect(run.output.pendingApproval).toBeUndefined();
  expect(fs.readFileSync(path.join(run.dir, 'settings.json'), 'utf8')).toBe(
    repaired,
  );
}, 20000);

test('the worker preserves intentionally invalid JSON fixtures and continues', async () => {
  const contents = '[1,]';
  const run = await runAgent([
    call('fixture', 'write', { path: 'invalid.json', contents }),
    call('next', 'write', {
      path: 'notes.txt',
      contents: 'Parser rejection fixture.',
    }),
  ]);
  expect(run.output.status).toBe('success');
  expect(run.output.pendingApproval).toBeUndefined();
  expect(fs.readFileSync(path.join(run.dir, 'invalid.json'), 'utf8')).toBe(
    contents,
  );
  expect(fs.readFileSync(path.join(run.dir, 'notes.txt'), 'utf8')).toBe(
    'Parser rejection fixture.',
  );
}, 20000);
