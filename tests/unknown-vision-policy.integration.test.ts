import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';
import { startScriptedModelServer } from './helpers/scripted-model-server.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temp = useTempDir('unknown-vision-worker-');
const runAgent = useContainerAgentHarness();
useCleanMocks({ resetModules: true, unstubAllEnvs: true, unstubAllGlobals: true });

test.each([true, false])('resolved unfamiliar-model policy preserves worker image access (%s)', async (allowed) => {
  const server = await startScriptedModelServer(async () => ({ role: 'assistant', content: 'A single sample pixel.' }));
  try {
    const root = temp();
    const model = 'nebius/example/unfamiliar-visual-model';
    vi.stubEnv('HYBRIDCLAW_DATA_DIR', root);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    vi.stubEnv('HYBRIDAI_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('NEBIUS_API_KEY', 'test-key');
    vi.stubEnv('HYBRIDCLAW_RETRY_ENABLED', 'false');
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      nebius: { enabled: true, baseUrl: `http://127.0.0.1:${server.port}/v1` },
      openrouter: { enabled: false },
      routing: { enabled: false },
      auxiliaryModels: { vision: { provider: 'auto', model: '' } },
    }));
    vi.resetModules();
    const routing = await import('../src/providers/task-routing.js');
    const policy = await routing.resolveTaskModelPolicy('vision', { sessionModel: model });
    expect(policy?.error).toBeUndefined();
    const run = await runAgent([
      { role: 'assistant', content: null, tool_calls: [{ id: 'inspect_pixel', type: 'function', function: {
        name: 'vision_analyze', arguments: JSON.stringify({ image_url: 'pixel.png', question: 'Describe the sample.' }),
      } }] },
      { role: 'assistant', content: 'Inspection finished.' },
    ], {
      provider: 'nebius', model, isLocal: false,
      allowedTools: ['vision_analyze'], visualMediaAllowed: allowed,
      primaryModelSupportsVisualMedia: false, taskModels: { vision: policy },
    }, {
      'pixel.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=', 'base64'),
    });
    expect(run.output.status).toBe('success');
    expect(run.output.toolExecutions?.find(entry => entry.name === 'vision_analyze')?.isError).toBe(!allowed);
    expect(server.requests).toHaveLength(allowed ? 1 : 0);
    if (allowed) {
      expect(server.requests[0]?.model).toBe('example/unfamiliar-visual-model');
      const content = server.requests[0]?.messages?.at(-1)?.content;
      expect(content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image_url' })]));
    }
  } finally {
    await new Promise<void>(resolve => { server.server.close(() => resolve()); server.server.closeAllConnections(); });
  }
});
