import { expect, test } from 'vitest';
import { buildInterruptedShutdownOutput } from '../container/src/shutdown-output.js';

test('builds a structured interrupted output for signal shutdown', () => {
  expect(buildInterruptedShutdownOutput('SIGINT')).toEqual({
    status: 'error',
    result: null,
    toolsUsed: [],
    toolExecutions: [],
    error:
      'Request interrupted: the agent process received SIGINT before producing a final response.',
  });
});

test('carries pending delegation side effects through an interrupted shutdown', () => {
  const sideEffects = {
    delegations: [{ action: 'delegate' as const, prompt: 'summarize inbox' }],
  };

  expect(buildInterruptedShutdownOutput('SIGTERM', sideEffects)).toMatchObject({
    status: 'error',
    sideEffects,
  });
  expect(buildInterruptedShutdownOutput('SIGTERM', undefined)).not.toHaveProperty(
    'sideEffects',
  );
});
