import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();

test.each(['nebius', 'openrouter', 'hybridai'] as const)(
  'rejects a truncated remote %s final after successful tool use',
  async (provider) => {
    const { output, requests } = await runAgent(
      [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'read-notes',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"notes.txt"}' },
          }],
        },
        {
          role: 'assistant',
          content: '',
          reasoning_content: 'The requested work is still unfinished.',
          finish_reason: 'length',
        },
      ],
      { provider, model: `${provider}/example-model`, isLocal: false },
      { 'notes.txt': 'Synthetic notes.' },
    );

    expect(output.status).toBe('error');
    expect(output.result).toBeNull();
    expect(output.error).toContain('output-token limit');
    expect(requests).toHaveLength(2);
    expect(output.toolExecutions).toEqual([
      expect.objectContaining({ name: 'read', isError: false }),
    ]);
    expect(output.tokenUsage?.modelCalls).toBe(2);
  },
);

test('rejects partial final text without replaying an earlier write', async () => {
  const { output, requests, dir } = await runAgent(
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'write-draft',
          type: 'function',
          function: {
            name: 'write',
            arguments: JSON.stringify({ path: 'draft.txt', contents: 'Saved draft.' }),
          },
        }],
      },
      { role: 'assistant', content: 'I have started the', finish_reason: 'length' },
    ],
    { provider: 'nebius', model: 'nebius/example-model', isLocal: false },
  );

  expect(output.status).toBe('error');
  expect(output.result).toBeNull();
  expect(output.error).toContain('output-token limit');
  expect(requests).toHaveLength(2);
  expect(fs.readFileSync(path.join(dir, 'draft.txt'), 'utf8')).toBe('Saved draft.');
  expect(output.toolExecutions).toEqual([
    expect.objectContaining({ name: 'write', isError: false }),
  ]);
});

test('keeps valid remote tool calls and complete final answers working', async () => {
  const { output, requests } = await runAgent(
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'read-notes',
          type: 'function',
          function: { name: 'read', arguments: '{"path":"notes.txt"}' },
        }],
      },
      { role: 'assistant', content: 'Notes read successfully.' },
    ],
    { provider: 'nebius', model: 'nebius/example-model', isLocal: false },
    { 'notes.txt': 'Synthetic notes.' },
  );

  expect(output.status).toBe('success');
  expect(output.result).toBe('Notes read successfully.');
  expect(requests).toHaveLength(2);
  expect(output.toolExecutions?.[0]).toMatchObject({ name: 'read', isError: false });
});
