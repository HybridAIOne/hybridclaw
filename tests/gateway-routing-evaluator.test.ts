import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DEFAULT_ROUTING_EVALUATOR } from '../src/routing/evaluator-contract.js';
import { captureRoutingTrace } from '../src/usage/routing-trace.js';
const mocks = vi.hoisted(() => ({ config: vi.fn(), secret: vi.fn(), fetch: vi.fn() }));
vi.mock('../src/config/runtime-config.js', () => ({ getRuntimeConfig: mocks.config }));
vi.mock('../src/security/runtime-secrets.js', () => ({ readStoredRuntimeSecret: mocks.secret }));
vi.mock('../src/providers/model-catalog.js', () => ({ getModelCatalogMetadata: () => ({ zone: 'cloud', pricingUsdPerToken: {} }) }));
import { evaluateConfiguredRouting } from '../src/gateway/routing-evaluator.js';
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.config.mockReturnValue({ routing: { evaluator: { ...DEFAULT_ROUTING_EVALUATOR, mode: 'shadow', publicPrompts: ['Explain photosynthesis.'] }, tiers: [{ name: 'first' }] } });
  mocks.secret.mockReturnValue('test-key');
});
test('unapproved live input never reads credentials or calls JEV', async () => {
  const result = await evaluateConfiguredRouting({ text: 'Meeting notes' });
  expect(result.reason).toBe('public-approval-required');
  expect(mocks.secret).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
});
test('context excludes even a saved approved prompt', async () => {
  expect((await evaluateConfiguredRouting({ text: 'Explain photosynthesis.', hasPrivateContext: true })).status).toBe('blocked');
  expect(mocks.fetch).not.toHaveBeenCalled();
});
test('playground defaults to no external disclosure', async () => {
  expect((await evaluateConfiguredRouting({ text: 'Example', playground: true })).status).toBe('blocked');
  expect(mocks.fetch).not.toHaveBeenCalled();
});
test('approved input records classifier tokens as auxiliary overhead', async () => {
  const answers = {tier: {type:'choice', choice:'first', confidence:1, probabilities:{first:1}}};
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ model: 'jev-test', answers, usage: { input_tokens: 100, output_tokens: 20 } })));
  const { result, trace } = await captureRoutingTrace(() => evaluateConfiguredRouting({ text: 'Explain photosynthesis.' }));
  expect(result.status).toBe('evaluated');
  expect(trace.attempts[0]).toMatchObject({ kind: 'auxiliary', inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: null });
  expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).state).toBe('Explain photosynthesis.');
});

test('JEV concierge authorizes current prompts independently of playground approval and mode', async () => {
  const config = mocks.config();
  config.routing.evaluator.mode = 'off';
  config.routing.enabled = true;
  config.routing.concierge = { model: 'jev/jev-latest' };
  mocks.secret.mockReturnValue(undefined);
  vi.stubEnv('JEV_API_KEY', '');
  try {
    const result = await evaluateConfiguredRouting({ text: 'Explain gravity.', concierge: true });
    expect(result).toMatchObject({ mode: 'active', reason: 'credential-missing', applied: false });
    expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.secret.mockClear();
    const blocked = await evaluateConfiguredRouting({ text: 'Confidential salary information', concierge: true });
    expect(blocked.status).toBe('blocked');
    expect(mocks.secret).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); }
});

test('availability accepts a gateway environment key without exposing its value', async () => {
  const { isJevAvailable } = await import('../src/gateway/routing-evaluator.js');
  mocks.secret.mockReturnValue(undefined);
  vi.stubEnv('JEV_API_KEY', 'test-key');
  try { expect(isJevAvailable()).toBe(true); }
  finally { vi.unstubAllEnvs(); }
});
