import { expect, test, vi } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';
import { startScriptedModelServer } from './helpers/scripted-model-server.js';
import { useCleanMocks } from './test-utils.js';

const runAgent = useContainerAgentHarness();
useCleanMocks({ unstubAllEnvs: true });
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=',
  'base64',
);

test.each([true, false])(
  'a worker preserves source fallback boundaries (local image exists: %s)',
  async (localExists) => {
    vi.stubEnv('HYBRIDCLAW_RETRY_ENABLED', 'false');
    let attempts = 0;
    const vision = await startScriptedModelServer(async () => {
      if (++attempts === 1 && localExists)
        throw new Error('Temporary overload');
      return { role: 'assistant', content: 'The image contains one pixel.' };
    });
    try {
      const run = await runAgent(
        [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'inspect_image',
                type: 'function',
                function: {
                  name: 'vision_analyze',
                  arguments: JSON.stringify({
                    image_url: 'pixel.png',
                    fallback_url: 'backup.png',
                    question: 'Describe the image.',
                  }),
                },
              },
            ],
          },
          { role: 'assistant', content: 'Inspection attempt finished.' },
        ],
        {
          allowedTools: ['vision_analyze'],
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
        { 'backup.png': pixel, ...(localExists ? { 'pixel.png': pixel } : {}) },
      );
      expect(run.output.status).toBe('success');
      expect(vision.requests).toHaveLength(1);
      const execution = run.output.toolExecutions?.find(
        (entry) => entry.name === 'vision_analyze',
      );
      expect(execution?.isError).toBe(localExists);
      const result = run.output.toolHistory?.find(
        (message) => message.tool_call_id === 'inspect_image',
      );
      if (localExists)
        expect(String(result?.content)).toContain('Temporary overload');
      else
        expect(JSON.parse(String(result?.content))).toMatchObject({
          success: true,
          source: expect.stringContaining('backup.png'),
        });
    } finally {
      await new Promise<void>((resolve, reject) => {
        vision.server.close((error) => (error ? reject(error) : resolve()));
        vision.server.closeAllConnections();
      });
    }
  },
);
