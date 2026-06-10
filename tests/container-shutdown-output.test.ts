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
