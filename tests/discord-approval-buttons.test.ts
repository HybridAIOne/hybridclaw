import type { Message } from 'discord.js';
import { expect, test, vi } from 'vitest';

import {
  buildApprovalActionRow,
  disableApprovalButtons,
  parseApprovalCustomId,
} from '../src/channels/discord/approval-buttons.js';

test('buildApprovalActionRow creates the expected approval buttons', () => {
  const row = buildApprovalActionRow('abc123').toJSON();

  expect(row.components).toHaveLength(4);
  expect(row.components.map((component) => component.custom_id)).toEqual([
    'approve:yes:abc123',
    'approve:session:abc123',
    'approve:agent:abc123',
    'approve:no:abc123',
  ]);
});

test('parseApprovalCustomId accepts valid ids and rejects invalid ones', () => {
  expect(parseApprovalCustomId('approve:session:abc123')).toEqual({
    action: 'session',
    approvalId: 'abc123',
  });
  expect(parseApprovalCustomId('approve:view:abc123')).toBeNull();
  expect(parseApprovalCustomId('not-an-approval')).toBeNull();
});

test('disableApprovalButtons edits the message with disabled buttons', async () => {
  const edit = vi.fn().mockResolvedValue(undefined);
  const message = {
    components: [buildApprovalActionRow('abc123').toJSON()],
    edit,
  } as unknown as Message;

  await disableApprovalButtons(message);

  expect(edit).toHaveBeenCalledTimes(1);
  const payload = edit.mock.calls[0][0] as {
    components: Array<{ toJSON(): { components: Array<{ disabled?: boolean }> } }>;
  };
  const json = payload.components[0].toJSON();
  expect(json.components.every((component) => component.disabled)).toBe(true);
});
