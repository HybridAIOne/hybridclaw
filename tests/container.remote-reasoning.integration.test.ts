import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const run = useContainerAgentHarness();

test.each(['nebius', 'openrouter'] as const)(
  '%s keeps effort across tool calls and updates it on the next turn',
  async (provider) => {
    const worker = await run(
      [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'write-receipt',
              type: 'function',
              function: {
                name: 'write',
                arguments: JSON.stringify({
                  path: 'receipt.txt',
                  contents: 'verified',
                }),
              },
            },
          ],
        },
        { role: 'assistant', content: 'Saved.' },
        { role: 'assistant', content: 'Next turn.' },
      ],
      {
        provider,
        model: `${provider}/example/model`,
        isLocal: false,
        reasoningEffort: 'medium',
        maxTokens: 131072,
        allowedTools: ['write'],
        approvalMode: 'full',
      },
    );
    expect(worker.output.status).toBe('success');
    expect(fs.readFileSync(path.join(worker.dir, 'receipt.txt'), 'utf8')).toBe(
      'verified',
    );
    expect(worker.requests).toHaveLength(2);
    for (const request of worker.requests) {
      expect(request.max_tokens).toBe(131072);
      expect(request.reasoning_effort).toBe(
        provider === 'nebius' ? 'medium' : undefined,
      );
      expect(request.reasoning).toEqual(
        provider === 'openrouter'
          ? { enabled: true, effort: 'medium' }
          : undefined,
      );
    }
    const next = await worker.followup({
      messages: [{ role: 'user', content: 'Start another independent task.' }],
      reasoningEffort: 'none',
    });
    expect(next.status).toBe('success');
    expect(worker.requests).toHaveLength(3);
    expect(worker.requests.at(-1)?.reasoning_effort).toBe(
      provider === 'nebius' ? 'none' : undefined,
    );
    expect(worker.requests.at(-1)?.reasoning).toEqual(
      provider === 'openrouter'
        ? { enabled: false, effort: 'none' }
        : undefined,
    );
  },
);
