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

test.each(['edit', 'write', 'bash', 'failed-bash'] as const)(
  'a verification read observes a preceding %s even after repeated earlier reads',
  async (kind) => {
    const mutation =
      kind === 'edit'
        ? call('change', 'edit', {
            path: 'record.txt',
            old: 'status: pending',
            new: 'status: ready',
          })
        : kind === 'write'
          ? call('change', 'write', {
              path: 'record.txt',
              contents: 'status: ready\n',
              overwrite: true,
              expected_content: 'status: pending\n',
            })
          : call('change', 'bash', {
              command: `printf 'status: ready\\n' > record.txt${kind === 'failed-bash' ? '; false' : ''}`,
            });
    const run = await runAgent(
      [
        ...Array.from({ length: 3 }, (_, i) =>
          call(`read-${i}`, 'read', { path: 'record.txt' }),
        ),
        mutation,
        call('verify', 'read', { path: 'record.txt' }),
        { role: 'assistant', content: 'Finished.' },
      ],
      {
        approvalMode: 'full',
        messages: [
          {
            role: 'user',
            content:
              'Inspect the example record, update its status, and verify it.',
          },
        ],
      },
      { 'record.txt': 'status: pending\n' },
    );
    expect(fs.readFileSync(path.join(run.dir, 'record.txt'), 'utf8')).toBe(
      'status: ready\n',
    );
    expect(run.output.toolExecutions?.[3]).toMatchObject({
      writeIntent: true,
      blocked: false,
      isError: kind === 'failed-bash',
    });
    const verification = run.output.toolExecutions?.at(-1);
    expect(verification, verification?.result).toMatchObject({
      name: 'read',
      isError: false,
    });
    expect(verification?.result).toContain('status: ready');
  },
);

test('batched discovery, edit, and verification retain their file dependency', async () => {
  const toolCalls = [
    ...Array.from({ length: 3 }, (_, i) =>
      call(`read-${i}`, 'read', { path: 'record.txt' }),
    ),
    call('change', 'edit', {
      path: 'record.txt',
      old: 'pending',
      new: 'ready',
    }),
    call('verify', 'read', { path: 'record.txt' }),
  ].flatMap((message) => message.tool_calls);
  const run = await runAgent(
    [
      { role: 'assistant', content: null, tool_calls: toolCalls },
      { role: 'assistant', content: 'Finished.' },
    ],
    { approvalMode: 'full' },
    { 'record.txt': 'status: pending\n' },
  );
  expect(run.output.toolExecutions?.at(-1)).toMatchObject({
    name: 'read',
    isError: false,
  });
  expect(run.output.toolExecutions?.at(-1)?.result).toContain('status: ready');
});

test('a blocked mutation does not erase evidence of an unchanged read loop', async () => {
  const run = await runAgent(
    [
      ...Array.from({ length: 3 }, (_, i) =>
        call(`read-${i}`, 'read', { path: 'record.txt' }),
      ),
      call('denied', 'bash', { command: 'eval "printf changed > record.txt"' }),
      call('repeat', 'read', { path: 'record.txt' }),
      { role: 'assistant', content: 'Finished.' },
    ],
    { approvalMode: 'full' },
    { 'record.txt': 'status: pending\n' },
  );
  expect(fs.readFileSync(path.join(run.dir, 'record.txt'), 'utf8')).toBe(
    'status: pending\n',
  );
  expect(run.output.toolExecutions?.[3]).toMatchObject({ blocked: true });
  expect(run.output.toolExecutions?.[4]).toMatchObject({ blocked: true });
});
