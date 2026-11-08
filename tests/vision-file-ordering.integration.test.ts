import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { ToolCall } from '../container/src/types.js';
import { useContainerAgentHarness } from './helpers/container-agent.js';
import { startScriptedModelServer } from './helpers/scripted-model-server.js';

const runAgent = useContainerAgentHarness();
const before =
  '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="red"/></svg>';
const after = before.replace('red', 'blue');

function call(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: name,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

test.each([
  ['write', false],
  ['edit', false],
  ['delete', false],
  ['write', true],
  ['edit', true],
] as const)(
  'vision observes the completed preceding %s (interruption window=%s)',
  async (mutation, interruptionWindow) => {
    const vision = await startScriptedModelServer(() => ({
      role: 'assistant',
      content: 'Image inspected.',
    }));
    try {
      const change = call(
        mutation,
        mutation === 'write'
          ? { path: 'chart.svg', contents: after }
          : mutation === 'edit'
            ? { path: 'chart.svg', old: 'red', new: 'blue' }
            : { path: 'chart.svg' },
      );
      const run = await runAgent(
        [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              change,
              call('vision_analyze', {
                image_url: './chart.svg',
                question: 'Describe the image.',
              }),
            ],
          },
          { role: 'assistant', content: 'Finished.' },
        ],
        {
          approvalMode: interruptionWindow ? 'auto' : 'full',
          visualMediaAllowed: true,
          primaryModelSupportsVisualMedia: false,
          taskModels: {
            vision: {
              provider: 'openrouter',
              baseUrl: `http://127.0.0.1:${vision.port}/v1`,
              apiKey: 'test-key',
              model: 'openrouter/example/image-model',
              chatbotId: '',
            },
          },
        },
        mutation === 'write' ? {} : { 'chart.svg': before },
        {
          prepare: async (dir) => {
            if (interruptionWindow) {
              fs.mkdirSync(path.join(dir, '.hybridclaw'));
              fs.writeFileSync(
                path.join(dir, '.hybridclaw', 'policy.yaml'),
                'approval:\n  implicit_delay_enabled: true\n',
              );
            }
            return {};
          },
        },
      );
      expect(run.output.toolExecutions?.[0]).toMatchObject({
        name: mutation,
        blocked: false,
        isError: false,
      });
      if (mutation === 'delete') {
        expect(fs.existsSync(path.join(run.dir, 'chart.svg'))).toBe(false);
        expect(vision.requests).toHaveLength(0);
        expect(run.output.toolExecutions?.[1]).toMatchObject({ isError: true });
      } else {
        expect(fs.readFileSync(path.join(run.dir, 'chart.svg'), 'utf8')).toBe(
          after,
        );
        expect(run.output.toolExecutions?.[1]).toMatchObject({
          isError: false,
        });
        expect(vision.requests).toHaveLength(1);
        const pixels = vision.requests[0].messages
          .flatMap((message) =>
            Array.isArray(message.content) ? message.content : [],
          )
          .find((part) => part.type === 'image_url');
        expect(pixels?.type).toBe('image_url');
        if (pixels?.type === 'image_url') {
          expect(
            Buffer.from(
              pixels.image_url.url.split(',')[1],
              'base64',
            ).toString(),
          ).toBe(after);
        }
      }
    } finally {
      await new Promise<void>((resolve) => {
        vision.server.close(() => resolve());
        vision.server.closeAllConnections();
      });
    }
  },
);

test('independent vision reads still execute concurrently', async () => {
  let arrived = 0;
  let release = () => {};
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  const vision = await startScriptedModelServer(async () => {
    if (++arrived === 2) release();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        bothArrived,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Vision reads ran serially')),
            2000,
          );
        }),
      ]);
      return { role: 'assistant', content: 'Image inspected.' };
    } finally {
      clearTimeout(timer);
    }
  });
  try {
    const first = call('vision_analyze', {
      image_url: 'chart.svg',
      question: 'Describe the image.',
    });
    const second = { ...first, id: 'second' };
    const run = await runAgent(
      [
        { role: 'assistant', content: null, tool_calls: [first, second] },
        { role: 'assistant', content: 'Finished.' },
      ],
      {
        approvalMode: 'full',
        visualMediaAllowed: true,
        primaryModelSupportsVisualMedia: false,
        taskModels: {
          vision: {
            provider: 'openrouter',
            baseUrl: `http://127.0.0.1:${vision.port}/v1`,
            apiKey: 'test-key',
            model: 'openrouter/example/image-model',
            chatbotId: '',
          },
        },
      },
      { 'chart.svg': before },
    );
    expect(vision.requests).toHaveLength(2);
    expect(run.output.toolExecutions?.map((tool) => tool.isError)).toEqual([
      false,
      false,
    ]);
  } finally {
    release();
    await new Promise<void>((resolve) => {
      vision.server.close(() => resolve());
      vision.server.closeAllConnections();
    });
  }
});
