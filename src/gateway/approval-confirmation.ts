import type { GatewayMessageComponents } from './gateway-types.js';

export function buildApprovalConfirmationComponents(
  approvalId: string,
): GatewayMessageComponents {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: 'Allow Once',
          custom_id: `approve:yes:${approvalId}`,
        },
        {
          type: 2,
          style: 1,
          label: 'Allow Session',
          custom_id: `approve:session:${approvalId}`,
        },
        {
          type: 2,
          style: 1,
          label: 'Allow Agent',
          custom_id: `approve:agent:${approvalId}`,
        },
        {
          type: 2,
          style: 1,
          label: 'Allow All',
          custom_id: `approve:all:${approvalId}`,
        },
        {
          type: 2,
          style: 4,
          label: 'Deny',
          custom_id: `approve:no:${approvalId}`,
        },
      ],
    },
  ];
}
