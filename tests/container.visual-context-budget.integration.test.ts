import { expect, test } from 'vitest';
import type { ChatMessage } from '../container/src/types.js';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();

test('continues with 32 PDF references on a text-only model without unnecessary compaction', async () => {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: 'Preserve the supplied document evidence. '.repeat(300),
    },
    { role: 'user', content: 'Compare all 32 supplied document extracts.' },
  ];
  for (let batch = 0; batch < 4; batch += 1) {
    const calls = Array.from({ length: 8 }, (_, offset) => {
      const index = batch * 8 + offset;
      return {
        id: `read-${index}`,
        type: 'function' as const,
        function: {
          name: 'read',
          arguments: JSON.stringify({
            path: `document-${index}.pdf`,
            pages: '1',
          }),
        },
      };
    });
    messages.push({ role: 'assistant', content: null, tool_calls: calls });
    for (const [offset, call] of calls.entries()) {
      const index = batch * 8 + offset;
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: `Evidence ${index}: ${'Complete extracted text. '.repeat(40)}`,
        visualAttachments: [
          { id: index.toString(16).padStart(64, '0'), pages: [1] },
        ],
      });
    }
  }
  const run = await runAgent(
    async (request) => {
      const results = request.messages.filter(
        (message) => message.role === 'tool',
      );
      expect(results).toHaveLength(32);
      expect(results.map(({ content }) => content)).toEqual(
        messages
          .filter((message) => message.role === 'tool')
          .map(({ content }) => content),
      );
      const serialized = JSON.stringify(request.messages);
      for (let index = 0; index < 32; index += 1)
        expect(serialized).toContain(index.toString(16).padStart(64, '0'));
      expect(serialized).not.toContain('base64');
      return {
        role: 'assistant',
        content: 'All supplied evidence is available.',
      };
    },
    {
      messages,
      allowedTools: ['read', 'vision_analyze'],
      visualMediaAllowed: true,
      primaryModelSupportsVisualMedia: false,
      contextWindow: 128_000,
    },
  );
  expect(run.output.status).toBe('success');
  expect(run.requests).toHaveLength(1);
  expect(run.output.toolExecutions).toHaveLength(0);
}, 30_000);
