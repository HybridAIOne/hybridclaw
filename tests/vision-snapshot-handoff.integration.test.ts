import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';
import { writeVisualPdfFixture } from './helpers/pdf-visual-fixture.js';
import { startScriptedModelServer } from './helpers/scripted-model-server.js';

const runAgent = useContainerAgentHarness();

test.each(['full', 'starred'] as const)(
  'a text-only worker analyzes a durable PDF page through %s tools',
  async (mode) => {
    const vision = await startScriptedModelServer(async () => ({
      role: 'assistant',
      content: 'The selected page contains colored shapes.',
    }));
    let stage = 0;
    try {
      const run = await runAgent(
        async (request) => {
          if (stage++ === 0) {
            return {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'read_page',
                  type: 'function',
                  function: {
                    name: 'read',
                    arguments: JSON.stringify({
                      path: 'workshop.pdf',
                      pages: '7',
                    }),
                  },
                },
              ],
            };
          }
          if (stage === 2) {
            const content = request.messages
              .flatMap((message) =>
                Array.isArray(message.content)
                  ? message.content
                      .filter((part) => part.type === 'text')
                      .map((part) => part.text)
                  : typeof message.content === 'string'
                    ? [message.content]
                    : [],
              )
              .join('\n');
            const start = content.indexOf(
              mode === 'full' ? '{"name":"vision_analyze"' : '{"snapshot"',
            );
            if (start < 0) throw new Error('Missing durable visual handoff.');
            const handoff = JSON.parse(
              content.slice(start, content.lastIndexOf('}') + 1),
            );
            const args = mode === 'full' ? handoff.arguments : handoff;
            return {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'analyze_page',
                  type: 'function',
                  function: {
                    name: mode === 'full' ? 'vision_analyze' : 'tool_catalog',
                    arguments: JSON.stringify(
                      mode === 'full'
                        ? args
                        : {
                            action: 'call',
                            name: 'vision_analyze',
                            arguments: args,
                          },
                    ),
                  },
                },
              ],
            };
          }
          return { role: 'assistant', content: 'The page was inspected.' };
        },
        {
          visualMediaAllowed: true,
          primaryModelSupportsVisualMedia: false,
          localToolMode: mode,
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
        {},
        {
          prepare: async (dir) => {
            await writeVisualPdfFixture(dir);
            return {};
          },
        },
      );
      expect(run.output.status).toBe('success');
      const read = run.output.toolHistory?.find(
        (message) => message.tool_call_id === 'read_page',
      );
      const analysis = run.output.toolHistory?.find(
        (message) => message.tool_call_id === 'analyze_page',
      );
      expect(read?.visualAttachments?.[0].pages).toEqual([7]);
      expect(analysis).toBeDefined();
      expect(JSON.parse(String(analysis?.content))).toMatchObject({
        success: true,
        page: 7,
      });
      expect(vision.requests).toHaveLength(1);
      expect(
        vision.requests[0].messages.flatMap((message) =>
          Array.isArray(message.content)
            ? message.content.filter((part) => part.type === 'image_url')
            : [],
        ),
      ).toHaveLength(1);
      expect(
        JSON.stringify(run.requests.map((request) => request.messages)),
      ).not.toContain('data:image');
      expect(JSON.stringify(run.output.toolHistory)).not.toContain('base64');
    } finally {
      await new Promise<void>((resolve, reject) => {
        vision.server.close((error) => (error ? reject(error) : resolve()));
        vision.server.closeAllConnections();
      });
    }
  },
  30_000,
);
