import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { toolResultDigest } from '@hybridclaw/shared/tool-history';
import {
  checkpointOutput,
  readTurnCheckpoint,
  TurnCheckpoint,
} from '@hybridclaw/shared/turn-checkpoint';
import { TurnToolHistory } from '../container/src/turn-tool-history.js';
import { restoreSpilledToolResults } from '../src/agent/spilled-tool-results.js';
import { recoverWorkerOutput } from '../src/infra/worker-recovery.js';
import { useTempDir } from './test-utils.js';

const temp = useTempDir('spilled-checkpoint-recovery-');
const session = 'recovered-results';
const runId = 'run-a';
const full = 'Exact response bytes: café\r\n'.repeat(2_000);
const assistant = (id = 'read-a') => ({
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

test('gateway recovery restores the full file-backed result while replay stays bounded', async () => {
  const root = temp();
  const history = new TurnToolHistory(session, root, root, runId);
  history.recordAssistant(assistant());
  await history.checkpointExecution('read-a', async () => ({
    output: full,
    isError: false,
  }));
  const recovered = recoverWorkerOutput(
    { status: 'error', result: null, toolsUsed: [], error: 'Worker stopped.' },
    root,
    session,
    runId,
    true,
  );
  expect(recovered.spilledToolCallIds).toEqual(['read-a']);
  const replay = recovered.toolHistoryForReplay?.[1].content;
  expect(String(replay).length).toBeLessThan(9_000);
  const restored = restoreSpilledToolResults(recovered, {
    sessionId: session,
    workspaceRoot: root,
  });
  expect(restored.toolHistory?.[1].content).toBe(full);
  expect(restored.toolExecutions?.[0].result).toBe(full);
  expect(restored.toolHistoryForReplay?.[1].content).toBe(replay);
  expect(restored.status).toBe('error');
  expect(restored.pendingApproval).toBeUndefined();
  expect(restored.sideEffects).toBeUndefined();
});

test('a failed spill never labels an inline result as file-backed', async () => {
  const root = temp();
  fs.writeFileSync(path.join(root, '.tool-results'), 'not a directory');
  const history = new TurnToolHistory(session, root, root, runId);
  history.recordAssistant(assistant());
  await history.checkpointExecution('read-a', async () => ({
    output: full,
    isError: false,
  }));
  const recovered = checkpointOutput(readTurnCheckpoint(root, session)!);
  expect(recovered.toolExecutions[0].result).toBe(full);
  expect('spilledToolCallIds' in recovered).toBe(false);
});

test.each([undefined, null, 0, 'invalid', 'A'.repeat(64)])(
  'rejects an invalid supplied result digest %j',
  (resultDigest) => {
    const root = temp();
    const checkpoint = new TurnCheckpoint(root, session, runId);
    checkpoint.assistant(assistant());
    const invalid = resultDigest === undefined ? '' : resultDigest;
    expect(() =>
      checkpoint.result({
        role: 'tool',
        tool_call_id: 'read-a',
        content: 'result',
        resultDigest: invalid,
      } as never),
    ).toThrow();
  },
);

test('repeated provider IDs do not restore one saved file as two different outcomes', async () => {
  const root = temp();
  const history = new TurnToolHistory(session, root, root, runId);
  for (const output of [full, 'Another exact result\n'.repeat(2_000)]) {
    history.recordAssistant(assistant());
    await history.checkpointExecution('read-a', async () => ({
      output,
      isError: false,
    }));
    history.recordResult({
      role: 'tool',
      tool_call_id: 'read-a',
      content: output,
    });
  }
  const recovered = recoverWorkerOutput(
    { status: 'error', result: null, toolsUsed: [], error: 'Stopped.' },
    root,
    session,
    runId,
    true,
  );
  expect(recovered.spilledToolCallIds).toEqual(['read-a']);
  const restored = restoreSpilledToolResults(recovered, {
    sessionId: session,
    workspaceRoot: root,
  });
  expect(restored.toolExecutions?.map((entry) => entry.result)).toEqual([
    full,
    'Another exact result\n'.repeat(2_000),
  ]);
  expect(recovered.toolExecutions?.[0].result).toContain(
    'Exact response bytes:',
  );
  expect(recovered.toolExecutions?.[1].result).toContain(
    'Another exact result',
  );
});

test('batch acknowledgment cannot remove a recorded spill flag', () => {
  const root = temp();
  const checkpoint = new TurnCheckpoint(root, session, runId);
  checkpoint.assistant(assistant());
  checkpoint.start('read-a');
  const result = {
    role: 'tool' as const,
    tool_call_id: 'read-a',
    content: 'saved reference',
  };
  checkpoint.result({ ...result, resultDigest: toolResultDigest(full) });
  expect(() => checkpoint.result(result)).toThrow();
});
