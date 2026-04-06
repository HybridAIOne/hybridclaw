import { expect, test } from 'vitest';

import { buildApprovalConfirmationComponents } from '../src/gateway/approval-confirmation.js';

test('buildApprovalConfirmationComponents creates the expected approval buttons', () => {
  expect(buildApprovalConfirmationComponents('abc123')).toEqual([
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: 'Allow Once',
          custom_id: 'approve:yes:abc123',
        },
        {
          type: 2,
          style: 1,
          label: 'Allow Session',
          custom_id: 'approve:session:abc123',
        },
        {
          type: 2,
          style: 1,
          label: 'Allow Agent',
          custom_id: 'approve:agent:abc123',
        },
        {
          type: 2,
          style: 1,
          label: 'Allow All',
          custom_id: 'approve:all:abc123',
        },
        {
          type: 2,
          style: 4,
          label: 'Deny',
          custom_id: 'approve:no:abc123',
        },
      ],
    },
  ]);
});
