import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temp = useTempDir('unknown-vision-policy-');
useCleanMocks({ unstubAllEnvs: true });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

test('automatic vision policy preserves endpoint negotiation for an unfamiliar remote model', async () => {
  const root = temp();
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', root);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  vi.stubEnv('HYBRIDAI_API_KEY', '');
  vi.stubEnv('OPENROUTER_API_KEY', '');
  vi.stubEnv('NEBIUS_API_KEY', 'test-key');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    nebius: { enabled: true },
    openrouter: { enabled: false },
    routing: { enabled: false },
    auxiliaryModels: { vision: { provider: 'auto', model: '' } },
  }));
  const fetchMock = vi.fn().mockRejectedValue(new Error('Unexpected network request'));
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
  const catalog = await import('../src/providers/model-catalog.js');
  const routing = await import('../src/providers/task-routing.js');
  const model = 'nebius/example/unfamiliar-visual-model';

  expect(catalog.isModelVisionCapable(model)).toBe(false);
  expect(await catalog.canModelAcceptVisualMedia(model)).toBe(true);
  const policy = await routing.resolveTaskModelPolicy('vision', { sessionModel: model });
  expect(policy).toMatchObject({ provider: 'nebius', model, apiKey: 'test-key', maxTokens: 8192 });
  expect(policy?.error).toBeUndefined();
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each(['anthropic', 'mistral'] as const)('discovered %s text-only metadata stays distinct from absence', async provider => {
  const root = temp();
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', root);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  vi.stubEnv(provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'MISTRAL_API_KEY', 'test-key');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ [provider]: { enabled: true } }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [
    { id: 'example-text', aliases: ['text-alias'], capabilities: { vision: false } },
    { id: 'example-vision', capabilities: { vision: true } },
  ], has_more: false })));
  vi.resetModules();
  let capability: (model: string) => boolean | null;
  if (provider === 'anthropic') {
    const discovery = await import('../src/providers/anthropic-discovery.js');
    await discovery.discoverAnthropicModels();
    capability = discovery.getDiscoveredAnthropicModelVisionCapability;
  } else {
    const discovery = await import('../src/providers/mistral-discovery.js');
    await discovery.discoverMistralModels();
    capability = discovery.getDiscoveredMistralModelVisionCapability;
    expect(capability('mistral/text-alias')).toBe(false);
  }
  expect(capability(`${provider}/example-text`)).toBe(false);
  expect(capability(`${provider}/example-vision`)).toBe(true);
  expect(capability(`${provider}/unlisted`)).toBeNull();
  const catalog = await import('../src/providers/model-catalog.js');
  expect(await catalog.canModelAcceptVisualMedia(`${provider}/example-text`)).toBe(false);
  expect(await catalog.canModelAcceptVisualMedia(`${provider}/unlisted`)).toBe(true);
});
