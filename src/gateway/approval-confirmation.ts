import { APPROVAL_BUTTON_LABELS } from './approval-button-labels.js';
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
          label: APPROVAL_BUTTON_LABELS.yes,
          custom_id: `approve:yes:${approvalId}`,
        },
        {
          type: 2,
          style: 1,
          label: APPROVAL_BUTTON_LABELS.session,
          custom_id: `approve:session:${approvalId}`,
        },
        {
          type: 2,
          style: 1,
          label: APPROVAL_BUTTON_LABELS.agent,
          custom_id: `approve:agent:${approvalId}`,
        },
        {
          type: 2,
          style: 1,
          label: APPROVAL_BUTTON_LABELS.all,
          custom_id: `approve:all:${approvalId}`,
        },
        {
          type: 2,
          style: 4,
          label: APPROVAL_BUTTON_LABELS.no,
          custom_id: `approve:no:${approvalId}`,
        },
      ],
    },
  ];
}
