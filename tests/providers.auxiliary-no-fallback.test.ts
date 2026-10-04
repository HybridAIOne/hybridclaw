import { beforeEach, expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

const mocks = vi.hoisted(() => ({ policy: vi.fn(), credentials: vi.fn(), health: vi.fn(), fetch: vi.fn() }));
vi.mock('../src/providers/task-routing.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/providers/task-routing.js')>()),
  isAuxiliaryTaskDisabled: () => false,
  resolveTaskModelPolicy: mocks.policy,
}));
vi.mock('../src/providers/factory.js', () => ({ resolveModelRuntimeCredentials: mocks.credentials, resolveModelProvider: vi.fn() }));
vi.mock('../src/providers/local-health.js', () => ({ localBackendsProbe: { get: mocks.health } }));
const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
useCleanMocks({ unstubAllGlobals: true });
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('fetch', mocks.fetch); });

test.each([
  [undefined, 'requires a configured auxiliary model'],
  [{ provider: 'vllm', model: 'vllm/aux', error: 'unavailable' }, 'is not configured'],
])('a restricted auxiliary call does not resolve a replacement for policy %j', async (policy, message) => {
  mocks.policy.mockResolvedValue(policy);
  await expect(callAuxiliaryModel({ task: 'eval_judge', fallbackModel: 'vllm/regular',
    messages: [{ role: 'user', content: 'Pick an emoji' }], allowFallback: false,
  })).rejects.toThrow(message);
  expect(mocks.credentials).not.toHaveBeenCalled();
  expect(mocks.health).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
});
