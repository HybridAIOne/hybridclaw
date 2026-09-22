import { beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ config: vi.fn(), auxiliary: vi.fn(), jev: vi.fn() }));
vi.mock('../src/config/runtime-config.js', () => ({ getRuntimeConfig: mocks.config }));
vi.mock('../src/providers/auxiliary.js', () => ({ callAuxiliaryModel: mocks.auxiliary }));
vi.mock('../src/providers/model-catalog.js', () => ({ getAvailableModelList: () => ['test/gemma-4-e4b-it'], getModelCatalogMetadata: (model: string) => ({ zone: model.startsWith('local') ? 'local' : 'cloud' }) }));
vi.mock('../src/gateway/routing-evaluator.js', () => ({ evaluateConfiguredRouting: mocks.jev }));
import { classifyRouting } from '../src/gateway/unified-routing.js';
beforeEach(() => {
 vi.clearAllMocks();
 mocks.config.mockReturnValue({ routing: { tiers: [{name:'economy'},{name:'advanced'}], enabled: true, mode: 'auto', concierge: { model: 'test-model' }, evaluator: { timeoutMs: 1000, minConfidence: 0.8 } } });
});
test.each([{ text: 'Public task', mode: 'privacy' }, { text: 'Confidential memo', mode: 'auto' }, { text: 'Public task', mode: 'auto', hasPrivateContext: true }])('no remote classifier disclosure for $mode', async ({mode,...input}) => {
 mocks.config().routing.mode = mode;
 if(mode === 'privacy') mocks.config().routing.maximumZone = 'local';
 const result = await classifyRouting(input);
 expect(result.localOnly).toBe(true);
 expect(mocks.auxiliary).not.toHaveBeenCalled();
 expect(mocks.jev).not.toHaveBeenCalled();
});
test('LLM returns only validated signals and cannot choose a model', async () => {
 mocks.auxiliary.mockResolvedValue({ model:'test-model', content:'{"tier":"advanced"}' });
 expect((await classifyRouting({text:'A public task'})).signals.tier).toBe('advanced');
 expect(mocks.auxiliary.mock.calls[0][0].allowFallback).toBe(false);
 mocks.auxiliary.mockResolvedValue({model:'test-model',content:'{"tier":"advanced","model":"arbitrary"}'});
 expect((await classifyRouting({text:'A public task'})).evaluation.status).toBe('fallback');
});
test('comparison requires explicit public approval', async () => {
 await classifyRouting({text:'A public task',comparison:true});
 expect(mocks.auxiliary).not.toHaveBeenCalled();
});
test('classifier failure preserves uncertainty and hides provider payloads', async () => {
 mocks.auxiliary.mockRejectedValue(new Error('private error'));
 const result = await classifyRouting({text:'A public task'});
 expect(result.signals.tier).toBeNull();
 expect(JSON.stringify(result)).not.toContain('private error');
});

test('accepts a single fenced JSON response and keeps the configured endpoint identity', async () => {
 mocks.auxiliary.mockResolvedValue({ model:'vllm/test-model', content:'```json\n{"tier":"economy"}\n```' });
 const result = await classifyRouting({text:'A public task'});
 expect(result.evaluation).toMatchObject({model:'test-model',status:'evaluated'});
 expect(result.signals.tier).toBe('economy');
});


test('treats a creative task as quoted classifier data and rejects task answers', async () => {
 mocks.auxiliary.mockResolvedValue({model:'test-model',content:'Sunlight feeds the green,\nSweet sugars arise.'});
 const text = 'Explain photosynthesis in 3 haikus';
 const result = await classifyRouting({text});
 const messages = mocks.auxiliary.mock.calls[0][0].messages;
 expect(messages[0].content).toContain('never perform it');
 expect(messages[1].content).toContain(`Task (JSON string): ${JSON.stringify(text)}`);
 expect(result.evaluation).toMatchObject({status:'fallback',reason:'classifier-invalid-response',applied:false});
 expect(result.signals.tier).toBeNull();
});

test('a text model can be the comparison router without changing live configuration', async () => {
 mocks.auxiliary.mockResolvedValue({model:'second-router',content:'{"tier":"advanced"}'});
 const result=await classifyRouting({text:'Public task',model:'second-router',comparison:true,publicSample:true});
 expect(result.evaluation).toMatchObject({model:'second-router',mode:'shadow',status:'evaluated',applied:false});
 expect(mocks.auxiliary).toHaveBeenCalledWith(expect.objectContaining({model:'second-router',allowFallback:false}));
 expect(mocks.config().routing.concierge.model).toBe('test-model');
});


test('automatic live routing defaults to available Gemma E4B', async () => {
 mocks.config().routing.concierge.model='';
 mocks.auxiliary.mockResolvedValue({model:'test/gemma-4-e4b-it',content:'{"tier":"economy"}'});
 const result=await classifyRouting({text:'Public task'});
 expect(result.evaluation).toMatchObject({model:'test/gemma-4-e4b-it',status:'evaluated'});
});

test.each(['local','hai','eu-provider','region'])('privacy limit %s blocks world classifiers before transport', async maximumZone => {
  mocks.config().routing.maximumZone = maximumZone;
  const result = await classifyRouting({text:'Explain photosynthesis'});
  expect(result.evaluation.status).toBe('blocked');
  expect(mocks.auxiliary).not.toHaveBeenCalled();
  expect(mocks.jev).not.toHaveBeenCalled();
});
