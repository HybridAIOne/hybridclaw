import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  checkpointOutput,
  readTurnCheckpoint,
  TurnCheckpoint,
  turnCheckpointPath,
} from '../container/shared/turn-checkpoint.js';
import { TurnToolHistory } from '../container/src/turn-tool-history.js';
import { recoverWorkerOutput } from '../src/infra/worker-recovery.js';
import { useTempDir } from './test-utils.js';

const temp = useTempDir('turn-checkpoint-');
const call = (id: string) => ({
  id,
  type: 'function' as const,
  function: {
    name: 'write',
    arguments: JSON.stringify({ path: `${id}.txt`, content: id }),
  },
});

test('a response without tool calls is retained for recovery and still allows provider routing', () => {
  const root = temp();
  const first = new TurnCheckpoint(root, 'session-a', 'run-a');
  first.assistant({ role: 'assistant', content: 'Sample response.' });
  expect(
    checkpointOutput(readTurnCheckpoint(root, 'session-a')!).error,
  ).toContain('Sample response.');
  expect(new TurnCheckpoint(root, 'session-a', 'run-a').recovered).toBeNull();
});

test('recovers completed, uncertain and unstarted calls distinctly without executing any', () => {
  const root = temp();
  const checkpoint = new TurnCheckpoint(root, 'session-a', 'run-a');
  checkpoint.assistant({
    role: 'assistant',
    content: 'Working.',
    tool_calls: ['done', 'unknown', 'unstarted'].map(call),
  });
  checkpoint.start('done');
  checkpoint.result({ role: 'tool', tool_call_id: 'done', content: 'Saved.' });
  checkpoint.start('unknown');
  const next = new TurnCheckpoint(root, 'session-a', 'run-a');
  const output = next.recovered!;
  expect(output.status).toBe('error');
  expect(output.toolExecutions.map((entry) => entry.toolCallId)).toEqual([
    'done',
    'unknown',
  ]);
  expect(output.toolHistory[1]).toMatchObject({ content: 'Saved.' });
  expect(output.toolHistory[2]).toMatchObject({ is_error: true });
  expect(output.toolHistory[2].content).toContain('unknown');
  expect(output.toolHistory[3].content).toContain('not executed');
  expect(fs.readdirSync(root)).toEqual(['.hybridclaw-runtime']);
  expect(new TurnCheckpoint(root, 'session-b', 'run-a').recovered).toBeNull();
  expect(new TurnCheckpoint(root, 'session-a', 'run-b').recovered).toBeNull();
});

test('checkpoints each parallel completion before the rest of its batch finishes', async () => {
  const root = temp();
  const history = new TurnToolHistory('parallel', root, root, 'run-a');
  history.recordAssistant({
    role: 'assistant',
    content: null,
    tool_calls: [call('fast'), call('slow')],
  });
  let finishSlow!: (value: { output: string; isError: boolean }) => void;
  const slow = history.checkpointExecution(
    'slow',
    () =>
      new Promise((resolve) => {
        finishSlow = resolve;
      }),
  );
  await history.checkpointExecution('fast', async () => ({
    output: 'Completed independently.',
    isError: false,
  }));
  const saved = readTurnCheckpoint(root, 'parallel')!;
  const recovered = checkpointOutput(saved);
  expect(recovered.toolHistory[1].content).toBe('Completed independently.');
  expect(recovered.toolHistory[2].content).toContain('unknown');
  finishSlow({ output: 'Finished.', isError: false });
  await slow;
});

test('fails before executing a tool when its start cannot be persisted', async () => {
  const root = temp();
  const history = new TurnToolHistory('unwritable', root, root, 'run-a');
  history.recordAssistant({
    role: 'assistant',
    content: null,
    tool_calls: [call('a')],
  });
  const dir = path.dirname(turnCheckpointPath(root, 'unwritable'));
  fs.rmSync(dir, { recursive: true });
  fs.writeFileSync(dir, 'not a directory');
  let ran = false;
  await expect(
    history.checkpointExecution('a', async () => {
      ran = true;
      return { output: 'Unexpected.', isError: false };
    }),
  ).rejects.toThrow();
  expect(ran).toBe(false);
});

test('a large completed outcome survives interruption with bounded replay and full evidence on disk', async () => {
  const state = temp();
  const execution = temp();
  const history = new TurnToolHistory('large', state, execution, 'run-a');
  history.recordAssistant({
    role: 'assistant',
    content: null,
    tool_calls: [call('a')],
  });
  const full = 'Report detail\n'.repeat(5000);
  const result = await history.checkpointExecution('a', async () => ({
    output: full,
    isError: false,
  }));
  expect(result.output).toBe(full);
  const recovered = new TurnToolHistory('large', state, execution, 'run-a')
    .recovered!;
  const replay = String(recovered.toolHistoryForReplay![1].content);
  expect(replay.length).toBeLessThan(16_000);
  const evidence = path.join(state, '.tool-results', 'large', 'a.txt');
  expect(replay).toContain(evidence);
  expect(fs.readFileSync(evidence, 'utf8')).toBe(full);
  expect(fs.readdirSync(execution)).toEqual([]);
  expect(recovered.toolExecutions![0].isError).toBe(false);
});

test('worker failure recovers evidence only for its own run, never queued side effects', () => {
  const root = temp();
  const checkpoint = new TurnCheckpoint(root, 'session-a', 'run-a');
  checkpoint.assistant({
    role: 'assistant',
    content: null,
    tool_calls: [call('a')],
  });
  checkpoint.start('a');
  const failure = {
    status: 'error' as const,
    result: null,
    toolsUsed: [],
    error: 'Worker exited.',
  };
  expect(recoverWorkerOutput(failure, root, 'session-a', 'run-b')).toBe(
    failure,
  );
  const recovered = recoverWorkerOutput(failure, root, 'session-a', 'run-a');
  expect(recovered.toolExecutions).toHaveLength(1);
  expect(recovered.sideEffects).toBeUndefined();
  expect(recovered.pendingApproval).toBeUndefined();
  const flushed = recoverWorkerOutput(
    {
      ...failure,
      toolHistory: [
        { role: 'assistant', content: null, tool_calls: [call('a')] },
        {
          role: 'tool',
          tool_call_id: 'a',
          content: 'outcome unknown',
          is_error: true,
        },
      ],
      sideEffects: {
        delegations: [{ action: 'delegate', prompt: 'Sample task.' }],
      },
    },
    root,
    'session-a',
    'run-a',
    true,
  );
  expect(flushed.sideEffects).toBeUndefined();
});

test('call IDs reused in later exchanges retain distinct outcomes', () => {
  const root = temp();
  const checkpoint = new TurnCheckpoint(root, 'session-a', 'run-a');
  for (const content of ['First exchange.', 'Second exchange.']) {
    checkpoint.assistant({
      role: 'assistant',
      content,
      tool_calls: [call('reused')],
    });
    checkpoint.start('reused');
    if (content === 'First exchange.')
      checkpoint.result({
        role: 'tool',
        tool_call_id: 'reused',
        content: 'First result.',
      });
  }
  const recovered = checkpointOutput(readTurnCheckpoint(root, 'session-a')!);
  expect(recovered.toolHistory.map((entry) => entry.role)).toEqual([
    'assistant',
    'tool',
    'assistant',
    'tool',
  ]);
  expect(recovered.toolHistory[1].content).toBe('First result.');
  expect(recovered.toolHistory[3].content).toContain('unknown');
  checkpoint.result({
    role: 'tool',
    tool_call_id: 'reused',
    content: 'Second result.',
  });
  const completed = checkpointOutput(readTurnCheckpoint(root, 'session-a')!);
  expect(
    completed.toolHistory
      .filter((entry) => entry.role === 'tool')
      .map((entry) => entry.content),
  ).toEqual(['First result.', 'Second result.']);
});

test('an authoritative error response keeps its actual results and queued side effects', () => {
  const root = temp();
  const checkpoint = new TurnCheckpoint(root, 'session-a', 'run-a');
  checkpoint.assistant({
    role: 'assistant',
    content: null,
    tool_calls: [call('a')],
  });
  checkpoint.start('a');
  const response = {
    status: 'error' as const,
    result: null,
    toolsUsed: [],
    error: 'Context exhausted.',
    toolHistory: checkpointOutput(readTurnCheckpoint(root, 'session-a')!)
      .toolHistory,
    sideEffects: {
      delegations: [{ action: 'delegate' as const, prompt: 'Sample task.' }],
    },
  };
  expect(recoverWorkerOutput(response, root, 'session-a', 'run-a')).toBe(
    response,
  );
  const interrupted = recoverWorkerOutput(
    response,
    root,
    'session-a',
    'run-a',
    true,
  );
  expect(interrupted.sideEffects).toBeUndefined();
  fs.writeFileSync(turnCheckpointPath(root, 'session-a'), '{');
  expect(recoverWorkerOutput(response, root, 'session-a', 'run-a')).toBe(
    response,
  );
  expect(
    recoverWorkerOutput(response, root, 'session-a', 'run-a', true).sideEffects,
  ).toBeUndefined();
});

test.each(['missing', 'stale', 'corrupt'])(
  'an interrupted %s journal never applies queued side effects',
  (kind) => {
    const root = temp();
    if (kind !== 'missing') {
      new TurnCheckpoint(root, 'session-a', 'older-run');
      if (kind === 'corrupt')
        fs.writeFileSync(turnCheckpointPath(root, 'session-a'), '{');
    }
    const output = recoverWorkerOutput(
      {
        status: 'error',
        result: null,
        toolsUsed: [],
        sideEffects: {
          delegations: [{ action: 'delegate', prompt: 'Sample task.' }],
        },
      },
      root,
      'session-a',
      'run-a',
      true,
    );
    expect(output.sideEffects).toBeUndefined();
  },
);

test.skipIf(process.platform === 'win32')(
  'rejects a FIFO checkpoint without waiting for a writer',
  () => {
    const root = temp();
    new TurnCheckpoint(root, 'session-a', 'run-a');
    const file = turnCheckpointPath(root, 'session-a');
    fs.unlinkSync(file);
    execFileSync('mkfifo', [file]);
    expect(() => readTurnCheckpoint(root, 'session-a')).toThrow(/regular file/);
  },
);

test.each([
  'orphan-result',
  'orphan-start',
  'unexpected-role',
  'duplicate-call',
])('rejects invalid checkpoint pairing: %s', (kind) => {
  const root = temp();
  new TurnCheckpoint(root, 'session-a', 'run-a');
  const file = turnCheckpointPath(root, 'session-a');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (kind === 'orphan-result')
    data.messages.push({
      role: 'tool',
      content: 'Saved.',
      tool_call_id: 'missing',
    });
  if (kind === 'orphan-start') data.started.push('missing');
  if (kind === 'unexpected-role')
    data.messages.push({ role: 'system', content: 'Unexpected.' });
  if (kind === 'duplicate-call')
    data.messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [call('same'), call('same')],
    });
  fs.writeFileSync(file, JSON.stringify(data));
  expect(() => readTurnCheckpoint(root, 'session-a')).toThrow();
});

test.each(['corrupt', 'oversize', 'symlink'] as const)(
  'refuses %s checkpoint evidence',
  (kind) => {
    const root = temp();
    new TurnCheckpoint(root, 'session-a', 'run-a');
    const file = turnCheckpointPath(root, 'session-a');
    if (kind === 'corrupt') fs.writeFileSync(file, '{');
    if (kind === 'symlink') {
      const other = path.join(root, 'other.json');
      fs.renameSync(file, other);
      fs.symlinkSync(other, file);
    }
    expect(() =>
      readTurnCheckpoint(
        root,
        'session-a',
        kind === 'oversize' ? 1 : undefined,
      ),
    ).toThrow();
    if (kind !== 'oversize')
      expect(() => new TurnCheckpoint(root, 'session-a', 'run-a')).toThrow();
  },
);
