import fs from 'node:fs';
import { expect, expectTypeOf, test } from 'vitest';
import {
  readTurnRecovery,
  TurnCheckpoint,
  turnCheckpointPath,
  type TurnRecoveryEvidence,
} from '@hybridclaw/shared/turn-checkpoint';
import { isRetrySafeRun } from '@hybridclaw/shared/retry-safety';
import {
  recoverWorkerFailure,
  recoverWorkerOutput,
} from '../src/infra/worker-recovery.js';
import { useTempDir } from './test-utils.js';

const temp = useTempDir('worker-evidence-');
const proposal = {
  role: 'assistant' as const,
  content: null,
  tool_calls: ['done', 'unknown', 'unstarted'].map((id) => ({
    id,
    type: 'function' as const,
    function: { name: 'write', arguments: '{}' },
  })),
};
const failure = {
  status: 'error' as const,
  result: null,
  toolsUsed: [],
  error: 'HTTP 503',
};

test('recovery exposes typed call evidence with no executable approval or queued effects', () => {
  expectTypeOf<
    TurnRecoveryEvidence['pendingApproval']
  >().toEqualTypeOf<undefined>();
  expectTypeOf<
    TurnRecoveryEvidence['sideEffects']
  >().toEqualTypeOf<undefined>();
  expectTypeOf<
    TurnRecoveryEvidence['approvalReply']
  >().toEqualTypeOf<undefined>();
  const root = temp();
  const journal = new TurnCheckpoint(root, 'session-a', 'run-a');
  journal.assistant(proposal);
  journal.start('done');
  journal.result({ role: 'tool', tool_call_id: 'done', content: 'Saved.' });
  journal.start('unknown');
  const recovered = readTurnRecovery(root, 'session-a', 'run-a');
  expect(recovered.kind).toBe('recovered');
  if (recovered.kind !== 'recovered') throw new Error('Expected evidence.');
  expect(recovered.evidence.recovery.calls.map((call) => call.outcome)).toEqual(
    ['result_recorded', 'outcome_unknown', 'not_executed'],
  );
  expect(isRetrySafeRun(recovered.evidence, false)).toBe(false);
});

test.each(['missing', 'run_mismatch', 'unreadable'] as const)(
  '%s evidence is terminal even when no tool progress was delivered',
  (reason) => {
    const root = temp();
    if (reason !== 'missing')
      new TurnCheckpoint(root, 'session-a', 'other-run');
    if (reason === 'unreadable')
      fs.writeFileSync(turnCheckpointPath(root, 'session-a'), '{');
    expect(readTurnRecovery(root, 'session-a', 'run-a')).toEqual({
      kind: 'refused',
      reason,
    });
    const output = recoverWorkerOutput(
      {
        ...failure,
        pendingApproval: { approvalId: 'approval-a' } as never,
        approvalReply: { decision: 'approve' } as never,
        sideEffects: {
          delegations: [{ action: 'delegate', prompt: 'Sample.' }],
        },
      },
      root,
      'session-a',
      'run-a',
      true,
    );
    expect(output.recovery?.kind).toBe('refused');
    expect(output.pendingApproval).toBeUndefined();
    expect(output.approvalReply).toBeUndefined();
    expect(output.sideEffects).toBeUndefined();
    expect(isRetrySafeRun(output, false)).toBe(false);
  },
);

test('exceptions after dispatch recover results without replaying the worker', () => {
  const root = temp();
  const journal = new TurnCheckpoint(root, 'session-a', 'run-a');
  journal.assistant({ ...proposal, tool_calls: [proposal.tool_calls[0]] });
  journal.start('done');
  journal.result({ role: 'tool', tool_call_id: 'done', content: 'Saved.' });
  const output = recoverWorkerFailure(
    new Error('IPC lost.'),
    root,
    'session-a',
    'run-a',
  );
  expect(output.toolHistory?.[1].content).toBe('Saved.');
  expect(isRetrySafeRun(output, false)).toBe(false);
});

test('an empty valid journal permits ordinary provider routing before any proposal', () => {
  const root = temp();
  new TurnCheckpoint(root, 'session-a', 'run-a');
  expect(recoverWorkerOutput(failure, root, 'session-a', 'run-a')).toBe(
    failure,
  );
  const interrupted = recoverWorkerOutput(
    failure,
    root,
    'session-a',
    'run-a',
    true,
  );
  expect(isRetrySafeRun(interrupted, false)).toBe(false);
});

test('a recovered IPC reply cannot retain executable controls', () => {
  const root = temp();
  const journal = new TurnCheckpoint(root, 'session-a', 'run-a');
  journal.assistant(proposal);
  const saved = readTurnRecovery(root, 'session-a', 'run-a');
  if (saved.kind !== 'recovered') throw new Error('Expected evidence.');
  const output = recoverWorkerOutput(
    {
      ...saved.evidence,
      pendingApproval: { approvalId: 'approval-a' } as never,
      sideEffects: { delegations: [{ action: 'delegate', prompt: 'Sample.' }] },
    },
    root,
    'session-a',
    'run-a',
  );
  expect(output.pendingApproval).toBeUndefined();
  expect(output.sideEffects).toBeUndefined();
  expect(output.recovery).toEqual(saved.evidence.recovery);
});

test('an interrupt wins over a success reply with executable controls', () => {
  const root = temp();
  new TurnCheckpoint(root, 'session-a', 'run-a');
  const output = recoverWorkerOutput(
    {
      status: 'success',
      result: 'Done.',
      toolsUsed: [],
      pendingApproval: { approvalId: 'approval-a' } as never,
      approvalReply: { decision: 'approve' } as never,
      sideEffects: { delegations: [{ action: 'delegate', prompt: 'Sample.' }] },
    },
    root,
    'session-a',
    'run-a',
    true,
  );
  expect(output.status).toBe('error');
  expect(output.result).toBeNull();
  expect(output.pendingApproval).toBeUndefined();
  expect(output.approvalReply).toBeUndefined();
  expect(output.sideEffects).toBeUndefined();
  expect(isRetrySafeRun(output, false)).toBe(false);
});
