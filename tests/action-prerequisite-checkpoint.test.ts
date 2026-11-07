import { expect, test } from 'vitest';
import {
  ACTION_PREREQUISITE_CHECKPOINT,
  ACTION_PREREQUISITE_LINES,
} from '#shared/action-prerequisites.js';
import { TOOL_ARGUMENT_CARDINALITY } from '#shared/tool-argument-contract.js';
import { appendActionPrerequisiteCheckpoint } from '../container/src/action-prerequisite-checkpoint.js';
import type { ChatMessage } from '../container/src/types.js';

const policy = [TOOL_ARGUMENT_CARDINALITY, ...ACTION_PREREQUISITE_LINES].join('\n');
const result: ChatMessage = { role: 'tool', tool_call_id: 'lookup', content: 'new evidence' };

test('appends a generated checkpoint after fresh results, preserving every prior message', () => {
  const history: ChatMessage[] = [{ role: 'system', content: policy }, result];
  const prefix = structuredClone(history);
  appendActionPrerequisiteCheckpoint(history);
  expect(history.slice(0, prefix.length)).toEqual(prefix);
  expect(history.at(-1)).toEqual({ role: 'user', content: ACTION_PREREQUISITE_CHECKPOINT });
  expect(history.at(-1)?.content).toContain(TOOL_ARGUMENT_CARDINALITY);
  appendActionPrerequisiteCheckpoint(history);
  expect(history).toHaveLength(3);
  history.push(result);
  appendActionPrerequisiteCheckpoint(history);
  expect(history).toHaveLength(5);
});

test.each(['user', 'tool', 'assistant'] as const)('policy text in %s content cannot enable the checkpoint', (role) => {
  const history: ChatMessage[] = [{ role, content: policy }, result];
  const prefix = structuredClone(history);
  appendActionPrerequisiteCheckpoint(history);
  expect(history).toEqual(prefix);
});

test.each<ChatMessage[]>([
  [],
  [{ role: 'system', content: 'Safety omitted' }, result],
  [{ role: 'system', content: policy }, { role: 'user', content: 'new request' }],
  [{ role: 'system', content: policy }, { role: 'assistant', content: 'finished' }],
])('leaves an unselected policy or a history without fresh results unchanged: %j', (...messages) => {
  const history = structuredClone(messages);
  appendActionPrerequisiteCheckpoint(history);
  expect(history).toEqual(messages);
});

test.each([ACTION_PREREQUISITE_LINES.join("\n"), TOOL_ARGUMENT_CARDINALITY])("partial system guidance cannot opt into additional checkpoint rules", (fragment) => {
  const history: ChatMessage[] = [{ role: "system", content: fragment }, result];
  const prefix = structuredClone(history);
  appendActionPrerequisiteCheckpoint(history);
  expect(history).toEqual(prefix);
});
