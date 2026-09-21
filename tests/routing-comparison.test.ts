import { beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ auxiliary: vi.fn(), jev: vi.fn() }));
vi.mock('../src/config/runtime-config.js', () => ({ getRuntimeConfig: () => ({ routing: { tiers: [{ name: 'economy', models: ['test-fast'] }], concierge: { profiles: { asap: 'test-fast', balanced: 'test-mid', noHurry: 'test-slow' } } } }) }));
vi.mock('../src/providers/auxiliary.js', () => ({ callAuxiliaryModel: mocks.auxiliary }));
vi.mock('../src/gateway/routing-evaluator.js', () => ({ evaluateConfiguredRouting: mocks.jev }));
vi.mock('../src/usage/routing-trace.js', () => ({ captureRoutingTrace: async (work: () => Promise<void>) => { await work(); return { trace: { attempts: [{ costUsd: 0.002 }] } }; } }));
import { compareRouting } from '../src/gateway/routing-comparison.js';
beforeEach(() => { vi.clearAllMocks(); mocks.jev.mockResolvedValue({ recommendedTier: 'economy', costUsd: 0.00004 }); });
test.each([{text:'Public prompt',publicSample:false},{text:'Confidential salary memo',publicSample:true}])('denies LLM disclosure for restricted input', async sample => {
  const result = await compareRouting({ ...sample, model: 'test-router' });
  expect(result.concierge.status).toBe('blocked');
  expect(mocks.auxiliary).not.toHaveBeenCalled();
});
test('compares the same sample and records classifier cost without executing a route', async () => {
  mocks.auxiliary.mockResolvedValue({ model: 'test-router', content: '{"decision":"pick_profile","profile":"asap"}', usage: { inputTokens: 20, outputTokens: 10 } });
  const result = await compareRouting({ text: 'Explain gravity urgently.', publicSample: true, model: 'test-router' });
  expect(result.concierge).toMatchObject({ status: 'evaluated', decision: 'asap', selectedModel: 'test-fast', tier: 'economy', costUsd: 0.002 });
  expect(mocks.auxiliary.mock.calls[0][0]).toMatchObject({ allowFallback: false, model: 'test-router', messages: [expect.anything(), { role: 'user', content: 'Explain gravity urgently.' }] });
  expect(mocks.jev).toHaveBeenCalledWith({ text: 'Explain gravity urgently.', publicSample: true, playground: true });
});
test('malformed classifier output cannot choose an arbitrary execution model', async () => {
  mocks.auxiliary.mockResolvedValue({ model: 'test-router', content: '{"decision":"pick_profile","profile":"arbitrary"}' });
  const result = await compareRouting({ text: 'Public prompt', publicSample: true, model: 'test-router' });
  expect(result.concierge).toMatchObject({ status: 'fallback', decision: 'classifier-failed', selectedModel: null });
});
