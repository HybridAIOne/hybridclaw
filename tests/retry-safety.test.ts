import { expect, test } from 'vitest';
import { isRetrySafeRun } from '../container/shared/retry-safety.js';

test.each([
  {
    label: 'a thrown run that reported no tool',
    output: null,
    toolProgressReported: false,
    retrySafe: true,
  },
  {
    label: 'a returned run without tools',
    output: { toolExecutions: [], pendingApproval: null },
    toolProgressReported: false,
    retrySafe: true,
  },
  {
    label: 'a thrown run that reported a tool',
    output: null,
    toolProgressReported: true,
    retrySafe: false,
  },
  {
    label: 'a returned run that reported a tool',
    output: { toolExecutions: [] },
    toolProgressReported: true,
    retrySafe: false,
  },
  {
    label: 'a run that returned tool executions',
    output: { toolExecutions: [{ name: 'write' }] },
    toolProgressReported: false,
    retrySafe: false,
  },
  {
    label: 'a run awaiting approval',
    output: { pendingApproval: { approvalId: 'approval_a' } },
    toolProgressReported: false,
    retrySafe: false,
  },
])('$label is retry-safe: $retrySafe', ({
  output,
  toolProgressReported,
  retrySafe,
}) => {
  expect(isRetrySafeRun(output, toolProgressReported)).toBe(retrySafe);
});
