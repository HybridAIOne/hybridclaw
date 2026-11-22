import { MESSAGE_TOOL_ACTIONS } from '@hybridclaw/contracts/message-action';
import { expect, test } from 'vitest';
import { normalizeMessageToolAction } from '../container/src/message-tool-actions.js';

test.each(MESSAGE_TOOL_ACTIONS)('canonical action %s maps to itself', (action) => {
  expect(normalizeMessageToolAction(action)).toBe(action);
});

test.each([
  ['dm', 'send'],
  ['post', 'send'],
  ['reply', 'send'],
  ['respond', 'send'],
  ['send_message', 'send'],
  ['history', 'read'],
  ['fetch', 'read'],
  ['read-messages', 'read'],
  ['lookup', 'member-info'],
  ['whois', 'member-info'],
  ['member_info', 'member-info'],
  [' Thread Create ', 'thread-create'],
])('alias %j normalizes to %s', (raw, expected) => {
  expect(normalizeMessageToolAction(raw)).toBe(expected);
});

test.each([
  'poll',
  '',
  'constructor',
  'toString',
  undefined,
  42,
])('unknown action %j is refused', (raw) => {
  expect(normalizeMessageToolAction(raw)).toBeNull();
});
