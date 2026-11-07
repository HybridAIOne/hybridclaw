import { expect, test } from 'vitest';
import { ACTION_PREREQUISITE_CHECKPOINT } from '../container/shared/action-prerequisites.js';
import type { ChatMessage } from '../container/src/types.js';
import { lastWorkflowMessage } from './helpers/scripted-model-server.js';

test.each<ChatMessage>([
  { role: 'tool', tool_call_id: 'lookup', content: 'result' },
  { role: 'user', content: 'Read result with rendered pages' },
  { role: 'user', content: 'A new request' },
  { role: 'user', content: '<runtime_policy_checkpoint>unrecognized text</runtime_policy_checkpoint>' },
])('scripts resume from the workflow message without changing captured policy: %j', (message) => {
  const messages: ChatMessage[] = [message, { role: 'user', content: ACTION_PREREQUISITE_CHECKPOINT }];
  const before = structuredClone(messages);
  expect(lastWorkflowMessage({ messages, tools: [] })).toBe(message);
  expect(messages).toEqual(before);
});

test('an empty scripted history has no workflow message', () => {
  expect(lastWorkflowMessage({ messages: [], tools: [] })).toBeUndefined();
});
