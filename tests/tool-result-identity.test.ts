import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { TurnToolHistory } from '../container/src/turn-tool-history.js';
import { restoreSpilledToolResults } from '../src/agent/spilled-tool-results.js';
import { recoverWorkerOutput } from '../src/infra/worker-recovery.js';
import { useTempDir } from './test-utils.js';

const temp = useTempDir('tool-result-identity-');
const session = 'identity';
const largeA = 'First neutral result.\r\n'.repeat(2_000);
const largeB = 'Second neutral result.\n'.repeat(2_000);
const call = (id: string) => ({
  role: 'assistant' as const,
  content: null,
  tool_calls: [
    {
      id,
      type: 'function' as const,
      function: { name: 'read', arguments: '{}' },
    },
  ],
});

test.each([
  { ids: ['same', 'same'], results: [largeA, largeB] },
  { ids: ['path/a', 'path_a'], results: [largeA, largeB] },
  { ids: ['same', 'same'], results: [largeA, 'small second result'] },
  { ids: ['same', 'same'], results: ['small first result', largeB] },
  { ids: ['same', 'same'], results: [largeA, largeA] },
  { ids: ['long'.repeat(100), 'long'.repeat(100)], results: [largeA, largeB] },
])(
  'restores each outcome rather than selecting by provider ID: $ids',
  ({ ids, results }) => {
    const root = temp();
    const history = new TurnToolHistory(session, root);
    results.forEach((content, index) => {
      history.recordAssistant(call(ids[index]));
      history.recordResult({ role: 'tool', tool_call_id: ids[index], content });
    });
    const replay = history.finish('done', true);
    const wire = history.withSpilledReferences({
      status: 'success',
      result: 'done',
      toolsUsed: ['read'],
      toolHistory: history.finish('done'),
      toolHistoryForReplay: replay,
      toolExecutions: results.map((result, index) => ({
        name: 'read',
        arguments: '{}',
        toolCallId: ids[index],
        result,
        durationMs: 0,
      })),
    });
    const restored = restoreSpilledToolResults(wire, {
      sessionId: session,
      workspaceRoot: root,
    });
    expect(
      restored.toolHistory
        ?.filter((message) => message.role === 'tool')
        .map((message) => message.content),
    ).toEqual(results);
    expect(restored.toolExecutions?.map((entry) => entry.result)).toEqual(
      results,
    );
    expect(restored.toolHistoryForReplay).toEqual(replay);
  },
);

test('both repeated-ID results survive checkpoint recovery with bounded replay', async () => {
  const root = temp();
  const history = new TurnToolHistory(session, root, root, 'run-a');
  for (const content of [largeA, largeB]) {
    history.recordAssistant(call('same'));
    await history.checkpointExecution('same', async () => ({
      output: content,
      isError: false,
    }));
    history.recordResult({ role: 'tool', tool_call_id: 'same', content });
  }
  const recovered = recoverWorkerOutput(
    { status: 'error', result: null, toolsUsed: [], error: 'Stopped.' },
    root,
    session,
    'run-a',
    true,
  );
  const restored = restoreSpilledToolResults(recovered, {
    sessionId: session,
    workspaceRoot: root,
  });
  expect(restored.toolExecutions?.map((entry) => entry.result)).toEqual([
    largeA,
    largeB,
  ]);
  expect(
    restored.toolHistoryForReplay
      ?.filter((entry) => entry.role === 'tool')
      .every((entry) => String(entry.content).length < 9_000),
  ).toBe(true);
  expect(restored.status).toBe('error');
  expect(
    fs.readdirSync(path.join(root, '.tool-results', session)),
  ).toHaveLength(2);
});
