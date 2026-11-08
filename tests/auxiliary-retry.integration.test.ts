import { beforeEach, expect, test, vi } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';
import { startScriptedModelServer } from './helpers/scripted-model-server.js';
import { useCleanMocks } from './test-utils.js';

const runAgent = useContainerAgentHarness();
useCleanMocks({ unstubAllEnvs: true });
beforeEach(() => {
  vi.stubEnv('HYBRIDCLAW_RETRY_ENABLED', 'true');
  vi.stubEnv('HYBRIDCLAW_RETRY_MAX_ATTEMPTS', '3');
  vi.stubEnv('HYBRIDCLAW_RETRY_BASE_DELAY_MS', '100');
  vi.stubEnv('HYBRIDCLAW_RETRY_MAX_DELAY_MS', '100');
});

test.each([1, 3])(
  'a real worker bounds and reports vision recovery after %i temporary failures',
  async (failures) => {
    let visionAttempts = 0;
    const vision = await startScriptedModelServer(async () => {
      if (visionAttempts++ < failures) throw new Error('Temporary overload');
      return {
        role: 'assistant',
        content: 'The image contains a single pixel.',
      };
    });
    let primaryAttempts = 0;
    try {
      const run = await runAgent(
        async () => {
          // The primary call must retain the same retry behavior after sharing policy.
          if (primaryAttempts++ === 0) throw new Error('Temporary overload');
          if (primaryAttempts === 2)
            return {
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
                      question: 'Describe this image.',
                    }),
                  },
                },
              ],
            };
          return {
            role: 'assistant',
            content:
              failures === 1
                ? 'The image was inspected.'
                : 'Image analysis is temporarily unavailable.',
          };
        },
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
        {
          'pixel.png': Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=',
            'base64',
          ),
        },
      );
      expect(run.output.status).toBe('success');
      expect(run.output.pendingApproval).toBeUndefined();
      expect(run.requests).toHaveLength(3);
      expect(run.requests[0]).toEqual(run.requests[1]);
      expect(vision.requests).toHaveLength(failures === 1 ? 2 : 3);
      for (const request of vision.requests) {
        expect(request).toEqual(vision.requests[0]);
        expect(request).toMatchObject({
          model: 'example/image-model',
          max_tokens: 8192,
        });
        expect(request.tools ?? []).toEqual([]);
      }
      const executions = run.output.toolExecutions?.filter(
        (entry) => entry.name === 'vision_analyze',
      );
      expect(executions).toHaveLength(1);
      expect(executions?.[0].isError).toBe(failures !== 1);
      const analysis = run.output.toolHistory?.find(
        (message) => message.tool_call_id === 'inspect_image',
      );
      if (failures === 1)
        expect(JSON.parse(String(analysis?.content))).toMatchObject({
          success: true,
          analysis: 'The image contains a single pixel.',
        });
      else expect(String(analysis?.content)).toContain('Temporary overload');
    } finally {
      await new Promise<void>((resolve, reject) => {
        vision.server.close((error) => (error ? reject(error) : resolve()));
        vision.server.closeAllConnections();
      });
    }
  },
  20_000,
);
