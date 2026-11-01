import { expect, test } from 'vitest';
import { estimateRoutedPromptOverheadTokens } from '../container/src/providers/router.js';
import { estimateTextTokens } from '../container/src/token-usage.js';
import type { ToolDefinition } from '../container/src/types.js';

test.each(['openrouter', 'anthropic', 'openai', 'hybridai', 'ollama'] as const)(
  'includes native tool schemas in the %s context budget',
  (provider) => {
    const tools: ToolDefinition[] = [
      {
        type: 'function',
        function: {
          name: 'read',
          description: 'A permitted file reader. '.repeat(40),
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
    ];
    const context = {
      provider,
      model: 'example-model',
      baseUrl: 'https://example.com/v1',
      apiKey: 'test-key',
      chatbotId: '',
      tools,
    };
    expect(estimateRoutedPromptOverheadTokens(context)).toBeGreaterThanOrEqual(
      estimateTextTokens(JSON.stringify(tools)),
    );
    expect(estimateRoutedPromptOverheadTokens({ ...context, tools: [] })).toBe(
      0,
    );
  },
);
