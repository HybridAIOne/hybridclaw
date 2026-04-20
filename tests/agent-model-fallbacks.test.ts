import { expect, test } from 'vitest';
import { resolveAgentModelFallbacks } from '../src/agents/agent-registry.ts';

test('resolveAgentModelFallbacks returns normalized fallbacks for the active primary model', () => {
  const agent = {
    id: 'research',
    model: {
      primary: 'ollama/llama3.2',
      fallbacks: [
        ' gpt-5-mini ',
        'openrouter/anthropic/claude-sonnet-4',
        'gpt-5-mini',
        'ollama/llama3.2',
      ],
    },
  } as const;

  expect(resolveAgentModelFallbacks(agent)).toEqual([
    'gpt-5-mini',
    'openrouter/anthropic/claude-sonnet-4',
  ]);
  expect(resolveAgentModelFallbacks(agent, 'ollama/llama3.2')).toEqual([
    'gpt-5-mini',
    'openrouter/anthropic/claude-sonnet-4',
  ]);
  expect(
    resolveAgentModelFallbacks(agent, 'anthropic/claude-3-7-sonnet'),
  ).toEqual([]);
  expect(
    resolveAgentModelFallbacks({
      id: 'main',
      model: 'gpt-5-mini',
    }),
  ).toEqual([]);
});
