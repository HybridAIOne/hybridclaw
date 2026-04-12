import { expect, test } from 'vitest';

import { buildSlackApprovalBlocks } from '../src/channels/slack/approval-buttons.js';

test('buildSlackApprovalBlocks uses the shared short approval labels', () => {
  const blocks = buildSlackApprovalBlocks('Approval required.', 'abc123');
  const actions = blocks.find((block) => block.type === 'actions');

  expect(actions).toBeDefined();
  if (!actions || actions.type !== 'actions') {
    throw new Error('Expected actions block.');
  }

  expect(actions.elements.map((element) => element.text.text)).toEqual([
    'Once',
    'Session',
    'Agent',
    'Always',
    'Deny',
  ]);
});
