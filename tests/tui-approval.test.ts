import { expect, test } from 'vitest';

import { formatTuiApprovalSummary } from '../src/tui-approval.js';

test('formats a compact approval summary with intent and reason', () => {
  expect(
    formatTuiApprovalSummary({
      approvalId: 'approve123',
      intent: 'control a local app with `open -a Music`',
      reason: 'this command controls host GUI or application state',
    }),
  ).toBe(
    [
      'Approval needed for: control a local app with `open -a Music`',
      'Why: this command controls host GUI or application state',
      'Approval ID: approve123',
    ].join('\n'),
  );
});

test('omits empty intent and reason lines', () => {
  expect(
    formatTuiApprovalSummary({
      approvalId: 'approve123',
      intent: ' ',
      reason: '',
    }),
  ).toBe('Approval ID: approve123');
});
