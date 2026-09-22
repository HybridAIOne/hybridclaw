import { beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ config: vi.fn(), auxiliary: vi.fn(), jev: vi.fn() }));
vi.mock('../src/config/runtime-config.js', () => ({ getRuntimeConfig: mocks.config }));
vi.mock('../src/providers/auxiliary.js', () => ({ callAuxiliaryModel: mocks.auxiliary }));
vi.mock('../src/providers/model-catalog.js', () => ({ getModelCatalogMetadata: (model: string) => ({ zone: model.startsWith('local') ? 'local' : 'cloud' }) }));
vi.mock('../src/gateway/routing-evaluator.js', () => ({ evaluateConfiguredRouting: mocks.jev }));
import { classifyRouting } from '../src/gateway/unified-routing.js';
beforeEach(() => {
 vi.clearAllMocks();
 mocks.config.mockReturnValue({ routing: { enabled: true, mode: 'auto', concierge: { model: 'test-model' }, evaluator: { timeoutMs: 1000, minConfidence: 0.8 } } });
});
test.each([{ text: 'Public task', mode: 'privacy' }, { text: 'Confidential memo', mode: 'auto' }, { text: 'Public task', mode: 'auto', hasPrivateContext: true }])('no remote classifier disclosure for $mode', async ({mode,...input}) => {
 mocks.config().routing.mode = mode;
 const result = await classifyRouting(input);
 expect(result.localOnly).toBe(true);
 expect(mocks.auxiliary).not.toHaveBeenCalled();
 expect(mocks.jev).not.toHaveBeenCalled();
});
test('LLM returns only validated signals and cannot choose a model', async () => {
 mocks.auxiliary.mockResolvedValue({ model:'test-model', content:'{"capability":"advanced","urgency":"urgent","sensitive":false}' });
 expect((await classifyRouting({text:'A public task'})).signals.capability).toBe('advanced');
 expect(mocks.auxiliary.mock.calls[0][0].allowFallback).toBe(false);
 mocks.auxiliary.mockResolvedValue({model:'test-model',content:'{"capability":"advanced","urgency":"urgent","sensitive":false,"model":"arbitrary"}'});
 expect((await classifyRouting({text:'A public task'})).evaluation.status).toBe('fallback');
});
test('comparison requires explicit public approval', async () => {
 await classifyRouting({text:'A public task',comparison:true});
 expect(mocks.auxiliary).not.toHaveBeenCalled();
});
test('classifier failure preserves uncertainty and hides provider payloads', async () => {
 mocks.auxiliary.mockRejectedValue(new Error('private error'));
 const result = await classifyRouting({text:'A public task'});
 expect(result.signals.capability).toBe('uncertain');
 expect(JSON.stringify(result)).not.toContain('private error');
});

test('accepts a single fenced JSON response and keeps the configured endpoint identity', async () => {
 mocks.auxiliary.mockResolvedValue({ model:'vllm/test-model', content:'```json\n{"capability":"basic","urgency":"unspecified","sensitive":false}\n```' });
 const result = await classifyRouting({text:'A public task'});
 expect(result.evaluation).toMatchObject({model:'test-model',status:'evaluated'});
 expect(result.signals.capability).toBe('basic');
});


test('treats a creative task as quoted classifier data and rejects task answers', async () => {
 mocks.auxiliary.mockResolvedValue({model:'test-model',content:'Sunlight feeds the green,\nSweet sugars arise.'});
 const text = 'Explain photosynthesis in 3 haikus';
 const result = await classifyRouting({text});
 const messages = mocks.auxiliary.mock.calls[0][0].messages;
 expect(messages[0].content).toContain('Never answer the task');
 expect(messages[1].content).toContain(`Task (JSON string): ${JSON.stringify(text)}`);
 expect(result.evaluation).toMatchObject({status:'fallback',reason:'classifier-invalid-response',applied:false});
 expect(result.signals.capability).toBe('uncertain');
});
