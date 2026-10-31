import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
useCleanMocks({
  resetModules: true,
  restoreAllMocks: true,
  unstubAllEnvs: true,
  unstubAllGlobals: true,
});

test.each([
  { allowed: false, primaryVision: false, calls: 0 },
  { allowed: false, primaryVision: true, calls: 0 },
  { allowed: true, primaryVision: false, calls: 1 },
  { allowed: true, primaryVision: true, calls: 1 },
])('auxiliary image policy %j', async ({ allowed, primaryVision, calls }) => {
  const root = tempDir();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  fs.writeFileSync(
    path.join(root, 'sample.jpg'),
    Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  );
  const fetch = vi.fn(async () =>
    Response.json({
      choices: [
        {
          message: { role: 'assistant', content: 'Visible content.' },
          finish_reason: 'stop',
        },
      ],
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const { executeToolWithMetadata, setMediaContext } = await import(
    '../container/src/tools.js'
  );
  const { setModelContext, setTaskModelPolicies } = await import(
    '../container/src/model-context.js'
  );
  setModelContext({
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'test-key',
    model: 'openrouter/example/text-model',
    chatbotId: '',
  });
  setTaskModelPolicies({
    vision: {
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      model: 'openrouter/example/image-model',
      chatbotId: '',
    },
  });
  setMediaContext([], [], allowed, primaryVision);
  const result = await executeToolWithMetadata(
    'vision_analyze',
    JSON.stringify({
      image_url: 'sample.jpg',
      question: 'Describe the image.',
    }),
  );
  expect(fetch).toHaveBeenCalledTimes(calls);
  expect(result.isError).toBe(!allowed);
  if (allowed)
    expect(JSON.parse(result.output).analysis).toBe('Visible content.');
});
