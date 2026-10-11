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

const messages = [{ role: 'user' as const, content: 'Pick an emoji' }];

test.each([
  [undefined, undefined, 'requires a configured auxiliary model'],
  [{ provider: 'vllm', model: 'vllm/aux', error: 'unavailable' }, 'vllm/regular', 'is not configured'],
])('a restricted auxiliary call does not resolve a replacement for policy %j', async (policy, fallbackModel, message) => {
  mocks.policy.mockResolvedValue(policy);
  await expect(callAuxiliaryModel({ task: 'eval_judge', fallbackModel, messages, allowFallback: false,
  })).rejects.toThrow(message);
  expect(mocks.credentials).not.toHaveBeenCalled();
  expect(mocks.health).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
});

test('an unconfigured restricted call uses the caller model without probing other providers', async () => {
  mocks.policy.mockResolvedValue(undefined);
  mocks.credentials.mockResolvedValue({ provider: 'hybridai', baseUrl: 'https://hybridai.test', apiKey: 'key',
    model: 'gpt-regular', chatbotId: 'bot', enableRag: false, requestHeaders: {}, isLocal: false });
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"emoji":"none"}' } }] })));
  const answer = await callAuxiliaryModel({ task: 'eval_judge', fallbackModel: 'gpt-regular', messages, allowFallback: false });
  expect(answer).toMatchObject({ provider: 'hybridai', model: 'gpt-regular', content: '{"emoji":"none"}' });
  expect(mocks.credentials).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-regular' }));
  expect(mocks.health).not.toHaveBeenCalled();
});
