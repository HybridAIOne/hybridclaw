import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import { createTokenUsageStats } from '../container/shared/token-usage.js';
import { isRetrySafeRun } from '../container/shared/retry-safety.js';
import {
  checkpointOutput,
  readTurnCheckpoint,
  TurnCheckpoint,
  turnCheckpointPath,
} from '../container/shared/turn-checkpoint.js';
import { buildInterruptedShutdownOutput } from '../container/src/shutdown-output.js';
import { TurnToolHistory } from '../container/src/turn-tool-history.js';
import { recoverWorkerOutput } from '../src/infra/worker-recovery.js';
import type { ChatMessage } from '../container/src/types.js';
import type { ContainerOutput } from '../src/types/container.js';
import { useTempDir } from './test-utils.js';

const temp = useTempDir('turn-checkpoint-usage-');
const usage = () => ({
  ...createTokenUsageStats(),
  modelCalls: 2,
  apiUsageAvailable: true,
  apiPromptTokens: 120,
  apiCompletionTokens: 12,
  apiTotalTokens: 132,
  estimatedPromptTokens: 240,
  estimatedCompletionTokens: 15,
});

test('failed usage persistence leaves the live snapshot consistent with durable recovery', () => {
  const root = temp();
  const checkpoint = new TurnCheckpoint(root, 'usage', 'run-a');
  checkpoint.usage(usage());
  const before = checkpoint.snapshot();
  const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
    throw new Error('Fixture storage failure');
  });
  try {
    expect(() => checkpoint.usage({ ...usage(), modelCalls: 3 })).toThrow(
      'Fixture storage failure',
    );
  } finally {
    rename.mockRestore();
  }
  expect(checkpoint.snapshot()).toEqual(before);
  expect(checkpointOutput(readTurnCheckpoint(root, 'usage')!)).toEqual(before);
  checkpoint.usage({ ...usage(), modelCalls: 3 });
  expect(checkpoint.snapshot().tokenUsage?.modelCalls).toBe(3);
});

test('recovers known usage without tool calls and keeps snapshots separate from the live accumulator', () => {
  const root = temp();
  const checkpoint = new TurnCheckpoint(root, 'usage', 'run-a');
  const stats = usage();
  checkpoint.usage(stats);
  stats.apiPromptTokens = 999;
  const saved = readTurnCheckpoint(root, 'usage')!;
  const output = recoverWorkerOutput(
    { status: 'error', result: null, toolsUsed: [] },
    root,
    'usage',
    'run-a',
  );
  expect(output.tokenUsage).toEqual({ ...usage(), estimatedTotalTokens: 255 });
  expect(isRetrySafeRun(output, false)).toBe(true);
  expect(checkpointOutput(saved).tokenUsage).toEqual(output.tokenUsage);
  expect(readTurnCheckpoint(root, 'other')).toBeNull();
  expect(
    recoverWorkerOutput(
      { status: 'error', result: null, toolsUsed: [] },
      root,
      'usage',
      'other',
    ),
  ).not.toHaveProperty('tokenUsage');
});

test('graceful shutdown retains a parallel completion before batch assembly and distinguishes unstarted work', async () => {
  const root = temp();
  const turn = new TurnToolHistory('parallel-usage', root, root, 'run-a');
  Object.assign(turn.tokenUsage, usage());
  turn.checkpointUsage();
  turn.recordAssistant({
    role: 'assistant',
    content: null,
    tool_calls: ['done', 'unknown', 'unstarted'].map((id) => ({
      id,
      type: 'function',
      function: {
        name: 'write',
        arguments: JSON.stringify({ path: `${id}.txt`, contents: id }),
      },
    })),
  });
  let finish!: (value: { output: string; isError: boolean }) => void;
  const running = turn.checkpointExecution(
    'unknown',
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await turn.checkpointExecution('done', async () => ({
    output: 'Saved.',
    isError: false,
  }));
  const output = buildInterruptedShutdownOutput('SIGTERM', undefined, turn);
  expect(output.status).toBe('error');
  expect(output.toolsUsed).toEqual(['write']);
  expect(
    output.toolExecutions?.map((entry) => [entry.toolCallId, entry.isError]),
  ).toEqual([
    ['done', false],
    ['unknown', true],
  ]);
  expect(output.toolHistory?.[1].content).toBe('Saved.');
  expect(output.toolHistory?.[2].content).toContain('unknown');
  expect(output.toolHistory?.[3].content).toContain('not executed');
  expect(output.tokenUsage).toMatchObject({
    apiPromptTokens: 120,
    apiCompletionTokens: 12,
    modelCalls: 2,
  });
  finish({ output: 'Finished later.', isError: false });
  await running;
  expect(output.toolHistory?.[2].content).toContain('unknown');
});

test.each([
  ['missing count', { modelCalls: undefined }],
  ['string count', { modelCalls: '2' }],
  ['negative tokens', { apiPromptTokens: -1 }],
  ['fractional tokens', { apiCompletionTokens: 1.2 }],
  ['unsafe count', { modelCalls: Number.MAX_SAFE_INTEGER + 1 }],
  [
    'overflowing estimate',
    {
      estimatedPromptTokens: Number.MAX_SAFE_INTEGER,
      estimatedCompletionTokens: 1,
    },
  ],
  [
    'overflowing API total',
    {
      apiPromptTokens: Number.MAX_SAFE_INTEGER,
      apiCompletionTokens: 1,
      apiTotalTokens: 0,
    },
  ],
  ['invalid availability', { apiUsageAvailable: 'true' }],
  ['invalid samples', { performanceSamples: {} }],
  ['invalid sample', { performanceSamples: [null] }],
  [
    'invalid duration',
    {
      performanceSamples: [
        {
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
          durationMs: -1,
        },
      ],
    },
  ],
])('rejects corrupt persisted usage: %s', (_label, fields) => {
  const root = temp();
  new TurnCheckpoint(root, 'usage', 'run-a');
  const file = turnCheckpointPath(root, 'usage');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.tokenUsage = { ...usage(), ...fields };
  fs.writeFileSync(file, JSON.stringify(data));
  expect(() => readTurnCheckpoint(root, 'usage')).toThrow();
  expect(
    recoverWorkerOutput(
      { status: 'error', result: null, toolsUsed: [] },
      root,
      'usage',
      'run-a',
    ).tokenUsage,
  ).toBeUndefined();
});

test.each([false, true])(
  'a valid IPC counter wins over an older checkpoint (interrupted=%s)',
  (interrupted) => {
    const root = temp();
    new TurnCheckpoint(root, 'usage', 'run-a').usage(usage());
    const output: ContainerOutput = {
      status: 'error',
      result: null,
      toolsUsed: [],
      tokenUsage: {
        ...usage(),
        apiPromptTokens: 200,
        apiCompletionTokens: 20,
        apiTotalTokens: 220,
      },
    };
    const recovered = recoverWorkerOutput(
      output,
      root,
      'usage',
      'run-a',
      interrupted,
    );
    expect(recovered.tokenUsage).toBe(output.tokenUsage);
    expect(isRetrySafeRun(recovered, false)).toBe(!interrupted);
    expect(readTurnCheckpoint(root, 'usage')?.tokenUsage?.apiTotalTokens).toBe(
      132,
    );
  },
);

test('usage-only recovery permits provider routing and the next attempt starts fresh counters', () => {
  const root = temp();
  const first = new TurnToolHistory('usage', root, root, 'run-a');
  Object.assign(first.tokenUsage, usage());
  first.checkpointUsage();
  const failure: ContainerOutput = {
    status: 'error',
    result: null,
    toolsUsed: [],
  };
  const firstOutput = recoverWorkerOutput(failure, root, 'usage', 'run-a');
  expect(firstOutput.tokenUsage?.apiTotalTokens).toBe(132);
  expect(firstOutput.recovery).toBeUndefined();
  expect(isRetrySafeRun(firstOutput, false)).toBe(true);
  const second = new TurnToolHistory('usage', root, root, 'run-a');
  expect(second.recovered).toBeNull();
  expect(second.tokenUsage).toEqual(createTokenUsageStats());
  Object.assign(second.tokenUsage, {
    apiUsageAvailable: true,
    modelCalls: 1,
    apiPromptTokens: 20,
    apiCompletionTokens: 2,
    apiTotalTokens: 22,
  });
  second.checkpointUsage();
  const secondOutput = recoverWorkerOutput(failure, root, 'usage', 'run-a');
  expect(secondOutput.tokenUsage?.apiTotalTokens).toBe(22);
  expect(firstOutput.tokenUsage?.apiTotalTokens).toBe(132);
});

test('an authoritative error gains missing usage without replacing its results or queued controls', () => {
  const root = temp();
  const journal = new TurnCheckpoint(root, 'usage', 'run-a');
  journal.usage(usage());
  const output: ContainerOutput = {
    status: 'error',
    result: 'Partial response',
    toolsUsed: [],
    sideEffects: {
      delegations: [
        {
          action: 'delegate',
          mode: 'single',
          prompt: 'Prepare an example report',
        },
      ],
    },
  };
  const recovered = recoverWorkerOutput(output, root, 'usage', 'run-a');
  expect(recovered).toEqual({
    ...output,
    tokenUsage: { ...usage(), estimatedTotalTokens: 255 },
  });
  expect(recovered.sideEffects).toBe(output.sideEffects);
  expect(recovered.recovery).toBeUndefined();
});

test.each(['missing', 'mismatched', 'corrupt'] as const)(
  'unavailable %s usage does not revoke an authoritative error',
  (kind) => {
    const root = temp();
    if (kind !== 'missing') {
      new TurnCheckpoint(root, 'usage', 'run-a').usage(usage());
      if (kind === 'corrupt')
        fs.writeFileSync(turnCheckpointPath(root, 'usage'), '{');
    }
    const output: ContainerOutput = {
      status: 'error',
      result: 'Partial response',
      toolsUsed: [],
    };
    expect(
      recoverWorkerOutput(
        output,
        root,
        'usage',
        kind === 'mismatched' ? 'run-b' : 'run-a',
      ),
    ).toBe(output);
  },
);

test('successful replies retain their own accounting contract', () => {
  const root = temp();
  new TurnCheckpoint(root, 'usage', 'run-a').usage(usage());
  const output: ContainerOutput = {
    status: 'success',
    result: 'Done',
    toolsUsed: [],
  };
  expect(recoverWorkerOutput(output, root, 'usage', 'run-a')).toBe(output);
});

test('recovered shutdown snapshots remain independent and cannot be written back', async () => {
  const root = temp();
  const first = new TurnToolHistory('usage', root, root, 'run-a');
  Object.assign(first.tokenUsage, usage());
  first.checkpointUsage();
  first.recordAssistant({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'done',
        type: 'function',
        function: { name: 'read', arguments: '{}' },
      },
    ],
  });
  await first.checkpointExecution('done', async () => ({
    output: 'Read complete',
    isError: false,
  }));
  const recovered = new TurnToolHistory('usage', root, root, 'run-a');
  const before = recovered.interruptedOutput('Stopped');
  const copy = recovered.interruptedOutput('Stopped');
  copy.tokenUsage!.apiTotalTokens = 999;
  copy.toolHistory![1].content = 'Modified caller copy';
  expect(recovered.interruptedOutput('Stopped')).toEqual(before);
  expect(() => recovered.checkpointUsage()).toThrow(/evidence only/);
  expect(
    checkpointOutput(readTurnCheckpoint(root, 'usage')!).tokenUsage
      ?.apiTotalTokens,
  ).toBe(132);
});

test('preserves reported cache and timing samples in independent snapshots', () => {
  const root = temp();
  const checkpoint = new TurnCheckpoint(root, 'usage', 'run-a');
  const stats = {
    ...usage(),
    apiCacheUsageAvailable: true,
    apiCacheReadTokens: 40,
    performanceSamples: [
      {
        promptTokens: 120,
        completionTokens: 12,
        totalTokens: 132,
        durationMs: 20,
        firstTextDeltaMs: 3,
      },
    ],
  };
  checkpoint.usage(stats);
  const output = checkpointOutput(readTurnCheckpoint(root, 'usage')!);
  expect(output.tokenUsage).toMatchObject({
    ...stats,
    estimatedTotalTokens: 255,
  });
  stats.performanceSamples[0].durationMs = 999;
  expect(output.tokenUsage?.performanceSamples?.[0].durationMs).toBe(20);
});

test('graceful accounting keeps compacted exchanges out of replay while retaining their evidence', async () => {
  const root = temp();
  const turn = new TurnToolHistory('compacted', root, root, 'run-a');
  const history: ChatMessage[] = [];
  turn.retain(history);
  for (const id of ['old', 'current']) {
    const assistant: ChatMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id, type: 'function', function: { name: 'read', arguments: '{}' } },
      ],
    };
    turn.recordAssistant(assistant);
    history.push(assistant);
    await turn.checkpointExecution(id, async () => ({
      output: `${id} result`,
      isError: false,
    }));
    if (id === 'old') {
      history.push(
        turn.recordResult({
          role: 'tool',
          tool_call_id: id,
          content: 'old result',
        }),
      );
      history.splice(0);
    }
  }
  const output = buildInterruptedShutdownOutput('SIGTERM', undefined, turn);
  expect(output.toolHistory).toHaveLength(4);
  expect(output.toolExecutions).toHaveLength(2);
  expect(output.toolHistoryForReplay).toHaveLength(2);
  expect(output.toolHistoryForReplay?.[1]).toMatchObject({
    tool_call_id: 'current',
    content: 'current result',
  });
  expect(JSON.stringify(output.toolHistoryForReplay)).not.toContain(
    'old result',
  );
});
