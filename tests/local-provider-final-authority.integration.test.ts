import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const run = useContainerAgentHarness();

test.each([false, true])(
  'a final answer cannot execute a hypothetical write from reasoning (stream=%s)',
  async (streamTextDeltas) => {
    const answer = 'The existing result is sufficient.';
    const worker = await run(
      [
        {
          role: 'assistant',
          reasoning_content:
            'A possible call would be <tool_call>{"name":"write","arguments":{"path":"unrequested.txt","contents":"Neutral sample."}}</tool_call>.',
          content: answer,
        },
        { role: 'assistant', content: answer },
      ],
      {
        provider: 'vllm',
        model: 'sample-model',
        modelBehavior: { thinkingFormat: 'qwen' },
        allowedTools: ['write'],
        approvalMode: 'full',
        streamTextDeltas,
      },
    );
    expect(worker.output.status, worker.stderr()).toBe('success');
    expect(fs.existsSync(path.join(worker.dir, 'unrequested.txt'))).toBe(false);
    expect(worker.output.toolExecutions ?? []).toEqual([]);
    expect(worker.output.result).toBe(answer);
    expect(worker.requests).toHaveLength(1);
  },
);

test.each([false, true])(
  'an explicit structured write still executes (stream=%s)',
  async (streamTextDeltas) => {
    const answer = 'The requested sample is ready.';
    const worker = await run(
      [
        {
          role: 'assistant',
          reasoning_content: 'A hypothetical call would write unrequested.txt.',
          content: 'Writing the requested sample.',
          tool_calls: [
            {
              id: 'requested',
              type: 'function',
              function: {
                name: 'write',
                arguments:
                  '{"path":"requested.txt","contents":"Requested neutral sample."}',
              },
            },
          ],
        },
        { role: 'assistant', content: answer },
      ],
      {
        provider: 'vllm',
        model: 'sample-model',
        modelBehavior: { thinkingFormat: 'qwen' },
        allowedTools: ['write'],
        approvalMode: 'full',
        streamTextDeltas,
      },
    );
    expect(worker.output.status, worker.stderr()).toBe('success');
    expect(
      fs.readFileSync(path.join(worker.dir, 'requested.txt'), 'utf8'),
    ).toBe('Requested neutral sample.');
    expect(fs.existsSync(path.join(worker.dir, 'unrequested.txt'))).toBe(false);
    expect(worker.output.toolExecutions?.map((entry) => entry.name)).toEqual([
      'write',
    ]);
    expect(worker.output.result).toBe(answer);
    expect(worker.requests).toHaveLength(2);
  },
);
