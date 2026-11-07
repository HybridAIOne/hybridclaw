import { expect, test, vi } from 'vitest';
import { canModelAcceptVisualMedia } from '../src/providers/model-catalog.js';
import { useCleanMocks } from './test-utils.js';

const { capability, discover } = vi.hoisted(() => ({
  capability: vi.fn<() => boolean | null>(),
  discover: vi.fn(),
}));
vi.mock('../src/providers/openrouter-discovery.js', async (original) => ({
  ...(await original<
    typeof import('../src/providers/openrouter-discovery.js')
  >()),
  discoverOpenRouterModels: discover,
  getDiscoveredOpenRouterModelVisionCapability: capability,
  isDiscoveredOpenRouterModelVisionCapable: () => capability() === true,
}));
useCleanMocks({ cleanup: () => { vi.clearAllMocks(); } });

test.each([
  { model: 'openrouter/example/unknown', discovered: false, accepts: false },
  { model: 'openrouter/example/unknown', discovered: true, accepts: true },
  { model: 'openrouter/example/unknown', discovered: null, accepts: true },
  { model: 'openrouter/openai/gpt-5-nano', discovered: false, accepts: false },
  { model: 'openai/gpt-5-nano', discovered: false, accepts: true },
  { model: 'example/unknown', discovered: false, accepts: true },
])('primary visual routing %j', async ({ model, discovered, accepts }) => {
  capability.mockReturnValue(discovered);
  await expect(canModelAcceptVisualMedia(model)).resolves.toBe(accepts);
  expect(discover).toHaveBeenCalledTimes(model.startsWith('openrouter/') ? 1 : 0);
});
