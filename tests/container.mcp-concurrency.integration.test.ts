import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { McpServerConfig } from '../container/src/mcp/types.js';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runContainerAgent = useContainerAgentHarness();

function call(id: string, name = 'lookup', args: Record<string, unknown> = {}) {
  return {
    id,
    type: 'function',
    function: {
      name: `mail__${name}`,
      arguments: JSON.stringify({ id, ...args }),
    },
  };
}

async function run(
  calls: ReturnType<typeof call>[],
  toolBehavior?: McpServerConfig['toolBehavior'],
) {
  const result = await runContainerAgent(
    [{ role: 'assistant', content: null, tool_calls: calls }],
    {},
    {},
    {
      prepare: async (dir) => ({
        mcpServers: {
          mail: {
            transport: 'stdio',
            command: process.execPath,
            args: [
              path.resolve('tests/fixtures/concurrent-mcp-server.mjs'),
              path.join(dir, 'calls.jsonl'),
            ],
            toolBehavior,
          },
        },
      }),
    },
  );
  const events = fs
    .readFileSync(path.join(result.dir, 'calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          event: string;
          name: string;
          id: string;
          active: number;
        },
    );
  return { ...result, events };
}

test('overlaps trusted reads with a cap of eight, orders results and drains before mutations', async () => {
  const reads = Array.from({ length: 10 }, (_, i) =>
    call(`r${i}`, 'lookup', { delay: 100 - i * 5, fail: i === 2 }),
  );
  const calls = [
    ...reads,
    call('mutation', 'mutate'),
    call('after-a'),
    call('after-b'),
  ];
  const { output, events } = await run(calls, { trustAnnotations: true });

  expect(output.status).toBe('success');
  expect(Math.max(...events.map((event) => event.active))).toBe(8);
  expect(output.toolExecutions?.map((execution) => execution.result)).toEqual(
    calls.map((entry) => (entry.id === 'r2' ? 'Error: r2' : entry.id)),
  );
  expect(output.toolExecutions?.[2].isError).toBe(true);
  const mutation = events.findIndex(
    (event) => event.id === 'mutation' && event.event === 'start',
  );
  expect(
    events
      .slice(0, mutation)
      .filter((event) => event.event === 'end')
      .map((event) => event.id)
      .sort(),
  ).toEqual(reads.map((entry) => entry.id).sort());
  expect(events[mutation]).toMatchObject({ active: 1 });
  expect(events[mutation + 1]).toMatchObject({
    event: 'end',
    id: 'mutation',
    active: 0,
  });
});

test('server read-only annotations alone remain serial', async () => {
  const { events } = await run([call('a'), call('b'), call('c')]);
  expect(events.map((event) => [event.event, event.id])).toEqual([
    ['start', 'a'],
    ['end', 'a'],
    ['start', 'b'],
    ['end', 'b'],
    ['start', 'c'],
    ['end', 'c'],
  ]);
});

test('an exact operator declaration admits reads without trusting annotations', async () => {
  const { events } = await run([call('a'), call('b')], {
    overrides: { lookup: 'read-only' },
  });
  expect(Math.max(...events.map((event) => event.active))).toBe(2);
});

test('a trusted scheduling override still stops at required approval', async () => {
  const { output, events } = await run(
    [
      call('a'),
      call('b'),
      call('approval', 'execute_action'),
      call('later-a'),
      call('later-b'),
    ],
    {
      trustAnnotations: true,
      overrides: { execute_action: 'read-only' },
    },
  );
  expect(output.pendingApproval).toMatchObject({
    toolName: 'mail__execute_action',
    approvalTier: 'red',
  });
  expect(output.toolExecutions?.at(-1)).toMatchObject({
    blocked: true,
    approvalDecision: 'required',
  });
  expect(
    events.filter((event) => event.event === 'start').map((event) => event.id),
  ).toEqual(['a', 'b']);
});
