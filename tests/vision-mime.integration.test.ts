import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';
import { startScriptedModelServer } from './helpers/scripted-model-server.js';

const runAgent = useContainerAgentHarness();
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=',
  'base64',
);

test('the real worker sends unchanged PNG bytes with PNG MIME despite a JPEG filename', async () => {
  const vision = await startScriptedModelServer(async (body) => {
    const content = body.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) throw new Error('Missing visual content');
    expect(content.find((part) => part.type === 'image_url')).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${png.toString('base64')}` },
    });
    return { role: 'assistant', content: 'Image inspected.' };
  });
  try {
    const run = await runAgent(
      [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'mime-check',
              type: 'function',
              function: {
                name: 'vision_analyze',
                arguments: JSON.stringify({
                  image_url: 'misnamed.jpg',
                  question: 'Describe the image.',
                }),
              },
            },
          ],
        },
        { role: 'assistant', content: 'Done.' },
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
      { 'misnamed.jpg': png },
    );
    expect(run.output.status).toBe('success');
    expect(
      run.output.toolExecutions?.find((x) => x.name === 'vision_analyze')
        ?.isError,
    ).toBe(false);
    expect(vision.requests).toHaveLength(1);
  } finally {
    await new Promise<void>((resolve, reject) => {
      vision.server.close((error) => (error ? reject(error) : resolve()));
      vision.server.closeAllConnections();
    });
  }
});
