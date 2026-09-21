import { beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ classify: vi.fn() }));
vi.mock('../src/gateway/unified-routing.js', () => ({ classifyRouting: mocks.classify }));
vi.mock('../src/config/runtime-config.js', () => ({ getRuntimeConfig: () => ({ routing: { enabled:true, mode:'speed', preference:'balanced', defaultStart:'first', tiers:[{name:'first',models:['test-small']},{name:'last',models:['test-large']}], evaluator:{model:'jev-latest'} } }) }));
vi.mock('../src/providers/model-catalog.js', () => ({ getModelCatalogMetadata: () => ({zone:'cloud',pricingUsdPerToken:{input:1,output:2}}) }));
import { compareRouting } from '../src/gateway/routing-comparison.js';
beforeEach(() => {vi.clearAllMocks(); mocks.classify.mockImplementation(async ({model}) => ({ signals:{capability:'advanced',urgency:'urgent',sensitive:false},localOnly:false,evaluation:{status:'evaluated',model,costUsd:0.01} }));});
test('both classifiers use the identical tier selection policy without execution', async () => {
 const result = await compareRouting({text:'Public task',model:'test-router',publicSample:true});
 expect(result.jev.recommendedTier).toBe('last');
 expect(result.concierge.recommendedTier).toBe('last');
 expect(result.jev.selectedModel).toBe(result.concierge.selectedModel);
 expect(mocks.classify).toHaveBeenCalledWith(expect.objectContaining({model:'jev/jev-latest',comparison:true,publicSample:true}));
});
