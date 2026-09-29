import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';
const temp = useTempDir();
useCleanMocks({ unstubAllEnvs: true, resetModules: true });
test('registered decision models are eligible as local routers but never as execution models', async () => {
 vi.stubEnv('HOME',temp('local-decision-config-')); vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER','1'); vi.resetModules();
 const registry=await import('../src/routing/local-classifiers.js');
 const config=await import('../src/config/runtime-config.js');
 registry.registerLocalClassifier({model:'local-decision/laya',label:'Laya',status:()=>({supported:true,installed:true,status:'running'}),command:vi.fn(),predict:vi.fn()});
 try {
  config.updateRuntimeConfig(draft=>{draft.local.backends.ollama.enabled=true; draft.routing.enabled=true; draft.routing.maximumZone='local';draft.routing.tiers=[{name:'local',models:['ollama/example']}];draft.routing.defaultStart='local';draft.routing.concierge={model:'local-decision/laya',comparisonModel:''};});
  expect(config.getRuntimeConfig().routing.concierge.model).toBe('local-decision/laya');
  expect(()=>config.updateRuntimeConfig(draft=>{draft.routing.tiers=[{name:'local',models:['local-decision/laya']}];})).toThrow();
 }finally{registry.clearLocalClassifiers();}
});
