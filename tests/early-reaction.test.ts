import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { chooseEarlyReaction } from '../src/gateway/early-reaction.js';

const { auxiliary, policy, metadata, dehydrate } = vi.hoisted(() => ({
  auxiliary: vi.fn(),
  policy: { provider: 'vllm', model: 'small/emoji-model', maxTokens: 16 },
  metadata: vi.fn(() => ({ zone: 'hai' })),
  dehydrate: vi.fn(messages => messages),
}));
vi.mock('../src/config/runtime-config.js', () => ({ getRuntimeConfig: () => ({ auxiliaryModels: { chat_reaction: policy } }) }));
vi.mock('../src/providers/auxiliary.js', () => ({ callAuxiliaryModel: auxiliary }));
vi.mock('../src/providers/model-catalog.js', () => ({ getModelCatalogMetadata: metadata }));
vi.mock('../src/security/confidential-runtime.js', () => ({ createConfidentialRuntimeContext: () => ({ dehydrate }) }));
vi.mock('../src/logger.js', () => ({ logger: { debug: vi.fn() } }));

const params = () => ({ agentId: 'test-agent', content: 'What is new?', maximumZone: 'hai' as const, onReaction: vi.fn() });
beforeEach(() => {
  policy.provider = 'vllm'; policy.model = 'small/emoji-model';
  auxiliary.mockReset().mockResolvedValue({ content: '📰' });
  metadata.mockReturnValue({ zone: 'hai' });
  vi.spyOn(Math, 'random').mockReturnValue(0.1);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test('roughly half the turns get a separate, validated early acknowledgement', async () => {
  vi.mocked(Math.random).mockReturnValueOnce(0).mockReturnValueOnce(0.49).mockReturnValueOnce(0.5).mockReturnValueOnce(0.99);
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await chooseEarlyReaction(params()));
  expect(results).toEqual(['📰', '📰', null, null]);
  expect(auxiliary).toHaveBeenCalledTimes(2);
  expect(auxiliary.mock.calls[0][0]).toMatchObject({ task: 'chat_reaction', allowFallback: false });
  expect(dehydrate).toHaveBeenCalled();
});

test.each(['words', '📰📰', '', '{"emoji":"📰"}'])('invalid model output %s is no reaction', async content => {
  auxiliary.mockResolvedValue({ content });
  const input = params();
  expect(await chooseEarlyReaction(input)).toBeNull();
  expect(input.onReaction).not.toHaveBeenCalled();
});

test('a deadline releases the reply and a late emoji is never delivered', async () => {
  vi.useFakeTimers();
  let finish: ((value: { content: string }) => void) | undefined;
  auxiliary.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const input = params();
  const result = chooseEarlyReaction(input);
  await vi.advanceTimersByTimeAsync(750);
  expect(await result).toBeNull();
  finish?.({ content: '📰' });
  await vi.advanceTimersByTimeAsync(0);
  expect(input.onReaction).not.toHaveBeenCalled();
});

test('cancellation and provider failure leave the conversational reply independent', async () => {
  auxiliary.mockRejectedValueOnce(new Error('offline'));
  expect(await chooseEarlyReaction(params())).toBeNull();
  auxiliary.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const input = { ...params(), abortSignal: controller.signal };
  const result = chooseEarlyReaction(input);
  controller.abort();
  expect(await result).toBeNull();
  expect(input.onReaction).not.toHaveBeenCalled();
});

test('an unconfigured, disabled or disallowed destination makes no request', async () => {
  policy.model = '';
  expect(await chooseEarlyReaction(params())).toBeNull();
  policy.model = 'small/emoji-model'; policy.provider = 'disabled';
  expect(await chooseEarlyReaction(params())).toBeNull();
  policy.provider = 'vllm'; metadata.mockReturnValue({ zone: 'cloud' });
  expect(await chooseEarlyReaction(params())).toBeNull();
  expect(auxiliary).not.toHaveBeenCalled();
});
