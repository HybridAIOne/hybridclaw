import { afterEach, expect, test, vi } from 'vitest';
import { DEFAULT_ROUTING_EVALUATOR } from '../src/routing/evaluator-contract.js';
import { clearLocalClassifiers, getLocalClassifier, registerLocalClassifier, restoreLocalClassifiers, snapshotLocalClassifiers } from '../src/routing/local-classifiers.js';
const mocks = vi.hoisted(() => ({ auxiliary: vi.fn(), remote: vi.fn() }));
vi.mock('../src/providers/auxiliary.js', () => ({ callAuxiliaryModel: mocks.auxiliary }));
vi.mock('../src/gateway/routing-evaluator.js', () => ({ evaluateConfiguredRouting: mocks.remote }));
vi.mock('../src/providers/model-catalog.js', () => ({ getModelCatalogMetadata: () => ({ zone: 'cloud' }) }));
vi.mock('../src/config/runtime-config.js', () => ({ getRuntimeConfig: () => ({ routing: { enabled: true, maximumZone: 'local', concierge: { model: 'local-decision/laya', comparisonModel: 'local-decision/laya' }, evaluator: DEFAULT_ROUTING_EVALUATOR, tiers: [{ name: 'small' }, { name: 'large' }] } }) }));
import { classifyRouting } from '../src/gateway/unified-routing.js';
afterEach(() => { clearLocalClassifiers(); vi.clearAllMocks(); });
const response = () => ({ model: 'laya-rl-agent', answers: { tier: { type: 'choice', choice: 'small', confidence: 0.9, probabilities: { small: 0.9, large: 0.1 } } }, usage: { input_tokens: 40, output_tokens: 0 } });
function register(predict = vi.fn().mockResolvedValue(response())) {
 registerLocalClassifier({ model: 'local-decision/laya', label: 'Laya', status: () => ({ supported: true, installed: true, status: 'running' }), command: vi.fn(), predict }); return predict;
}
test('local decisions work under local privacy and preserve identity, confidence and zero cost', async () => {
 const predict = register();
 const result = await classifyRouting({ text: 'Explain gravity.' });
 expect(result.evaluation).toMatchObject({ provider: 'local-decision', model: 'local-decision/laya', status: 'evaluated', recommendedTier: 'small', costUsd: 0, outputTokens: 0, applied: false });
 expect(result.localOnly).toBe(true);
 expect(predict.mock.calls[0][0].questions.tier.criteria).toHaveProperty('large');
 expect(mocks.remote).not.toHaveBeenCalled(); expect(mocks.auxiliary).not.toHaveBeenCalled();
});
test.each(['unknown-tier', 'invalid-probability', 'low-confidence', 'failed'])('fails closed for %s without cloud fallback', async kind => {
 const raw = response();
 if (kind === 'unknown-tier') raw.answers.tier.choice = 'unconfigured';
 if (kind === 'invalid-probability') raw.answers.tier.probabilities.small = 4;
 if (kind === 'low-confidence') raw.answers.tier.confidence = 0.3;
 const predict = kind === 'failed' ? vi.fn().mockRejectedValue(new Error('private provider payload')) : vi.fn().mockResolvedValue(raw);
 register(predict);
 const result = await classifyRouting({ text: 'Explain gravity.' });
 expect(result.evaluation.status).toBe('fallback'); expect(result.signals.tier).toBeNull();
 expect(JSON.stringify(result)).not.toContain('private provider payload');
 expect(mocks.remote).not.toHaveBeenCalled(); expect(mocks.auxiliary).not.toHaveBeenCalled();
});
test.each([{ text: 'confidential budget' }, { text: 'Public task', hasPrivateContext: true }, { text: 'Public task', comparison: true }])('retains existing disclosure guards', async input => {
 const predict = register();
 expect((await classifyRouting(input)).evaluation.status).toBe('blocked'); expect(predict).not.toHaveBeenCalled();
});
test('configured comparison remains shadow evidence', async () => {
 register(); expect((await classifyRouting({text:'Explain gravity.', comparison:true, configuredComparison:true})).evaluation).toMatchObject({status:'evaluated',mode:'shadow',applied:false});
});
test('registration snapshots roll back and reject duplicate or remote ids', () => {
 const empty = snapshotLocalClassifiers(); register(); const registration = getLocalClassifier('local-decision/laya')!;
 expect(() => registerLocalClassifier(registration)).toThrow(); expect(() => registerLocalClassifier({...registration, model:'https://example.com'})).toThrow();
 restoreLocalClassifiers(empty); expect(getLocalClassifier(registration.model)).toBeUndefined();
});

test.each([0.79, 0.8])('local selected-option confidence honors the configured boundary at %s', async confidence => {
 const raw = response();
 raw.answers.tier.confidence = confidence;
 raw.answers.tier.probabilities = {small: confidence, large: 1 - confidence};
 register(vi.fn().mockResolvedValue(raw));
 const result = await classifyRouting({text: 'Calculate 2+4'});
 expect(result.evaluation.status).toBe(confidence < 0.8 ? 'fallback' : 'evaluated');
 expect(result.signals.tier).toBe(confidence < 0.8 ? null : 'small');
});
