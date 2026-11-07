import { expect, test } from 'vitest';
import {
  ACTION_PREREQUISITE_CHECKPOINT,
  ACTION_PREREQUISITE_LINES,
} from '#shared/action-prerequisites.js';
import { TOOL_ARGUMENT_CARDINALITY } from '#shared/tool-argument-contract.js';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const run = useContainerAgentHarness();

test.each([true, false])('real worker reapplies only a selected policy after tool evidence: %j', async (enabled) => {
  const messages = [
    { role: 'system' as const, content: enabled ? [TOOL_ARGUMENT_CARDINALITY, ...ACTION_PREREQUISITE_LINES].join('\n') : 'Answer using the available tools.' },
    { role: 'user' as const, content: 'Read the notes.' },
  ];
  const worker = await run([
    { role: 'assistant', content: null, tool_calls: [{
      id: 'lookup', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'notes.txt' }) },
    }] },
    { role: 'assistant', content: 'Need a clarification before proposing.' },
  ], { messages, allowedTools: ['read'] }, { 'notes.txt': 'Two claims require clarification.' });
  expect(worker.requests).toHaveLength(2);
  const [first, next] = worker.requests;
  expect(next.messages.slice(0, first.messages.length)).toEqual(first.messages);
  expect(next.tools).toEqual(first.tools);
  expect(next.messages.filter((message) => message.content === ACTION_PREREQUISITE_CHECKPOINT)).toHaveLength(enabled ? 1 : 0);
  expect(next.messages.at(-1)?.role).toBe(enabled ? 'user' : 'tool');
  expect(worker.output.toolExecutions).toHaveLength(1);
  expect(worker.output.toolExecutions?.[0].isError).toBe(false);
});
