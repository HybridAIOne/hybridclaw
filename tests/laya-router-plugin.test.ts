import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(()=>({spawn:vi.fn()}));
vi.mock('node:child_process',()=>({spawn:mocks.spawn}));
// Plugin JS is intentionally shipped outside the gateway TypeScript startup graph.
import { LayaRuntime } from '../plugins/laya-router/src/runtime.js';
import plugin from '../plugins/laya-router/src/index.js';
afterEach(()=>vi.clearAllMocks());
function child() {
 const process = Object.assign(new EventEmitter(), {stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null,signalCode:null,kill:vi.fn()});
 process.kill.mockImplementation(()=>{queueMicrotask(()=>process.emit('exit',null,'SIGTERM'));return true;});
 mocks.spawn.mockReturnValue(process);return process;
}
test('plugin registers a separate decision model and gateway shutdown hook',()=>{
 const api={runtime:{homeDir:'/tmp/example'},resolvePath:(p:string)=>`/tmp/plugin/${p}`,registerLocalClassifier:vi.fn(),registerService:vi.fn()};
 plugin.register(api);
 expect(api.registerLocalClassifier).toHaveBeenCalledWith(expect.objectContaining({model:'local-decision/laya'}));
 expect(api.registerService).toHaveBeenCalledWith(expect.objectContaining({stop:expect.any(Function)}));
 expect(mocks.spawn).not.toHaveBeenCalled();
});
test('offline resident process answers multiple decisions and rejects simultaneous work',async()=>{
 const process=child();const runtime=new LayaRuntime({home:'/tmp/example',component:'/tmp/plugin'});
 const started=runtime.start();process.stdout.write('{"ready":true}\n');await started;
 expect(mocks.spawn.mock.calls[0][2].env).toMatchObject({HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'});
 const input={text:'Example',questions:{tier:{}},signal:new AbortController().signal};
 const first=runtime.predict(input);
 await expect(runtime.predict(input)).rejects.toThrow('busy');
 process.stdout.write('{"result":{"model":"laya-rl-agent"}}\n');await expect(first).resolves.toEqual({model:'laya-rl-agent'});
 const second=runtime.predict(input);process.stdout.write('{"error":"private details"}\n');await expect(second).rejects.toThrow('Local decision failed.');
 await runtime.stop();expect(process.kill).toHaveBeenCalledWith('SIGTERM');expect(runtime.status().status).toBe('stopped');
});
test('aborted decisions terminate their process and never leave a pending response',async()=>{
 const process=child();const runtime=new LayaRuntime({home:'/tmp/example',component:'/tmp/plugin'});
 const started=runtime.start();process.stdout.write('{"ready":true}\n');await started;
 const controller=new AbortController();const result=runtime.predict({text:'Example',questions:{},signal:controller.signal});controller.abort();await expect(result).rejects.toThrow('Cancelled');
 expect(process.kill).toHaveBeenCalledWith('SIGTERM');await expect(runtime.predict({text:'Example',questions:{},signal:new AbortController().signal})).rejects.toThrow('unavailable');
});
test('process death or malformed output fails pending requests safely',async()=>{
 const process=child();const runtime=new LayaRuntime({home:'/tmp/example',component:'/tmp/plugin'});
 const started=runtime.start();process.stdout.write('{"ready":true}\n');await started;
 const result=runtime.predict({text:'Example',questions:{},signal:new AbortController().signal});process.stdout.write('invalid\n');await expect(result).rejects.toThrow('unavailable');expect(runtime.status().status).toBe('error');
});

test('startup timeout kills the child and exposes a retryable error state', async () => {
  vi.useFakeTimers();
  try {
    const process = child();
    const runtime = new LayaRuntime({ home: '/tmp/example', component: '/tmp/plugin' });
    const result = runtime.start();
    const assertion = expect(result).rejects.toThrow('Startup failed');
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
    expect(process.kill).toHaveBeenCalledWith('SIGKILL');
    expect(runtime.status().status).toBe('error');
  } finally { vi.useRealTimers(); }
});

test('setup publishes actual runtime, download and loading phases', async () => {
 const runtime = new LayaRuntime({ home: '/tmp/example', component: '/tmp/plugin' });
 // Reuse the real setup sequencing without installing packages or writing files.
 const fs = (await import('node:fs')).default;
 const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
 const remove = vi.spyOn(fs, 'rmSync').mockImplementation(() => {});
 const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
 try {
   const states: string[] = [];
   vi.spyOn(runtime, 'run').mockImplementation(async () => { states.push(runtime.status().status); });
   vi.spyOn(runtime, 'start').mockImplementation(async () => { states.push(runtime.status().status); });
   runtime.state = 'setup';
   await runtime.setup();
   expect(states).toEqual(['setup', 'downloading', 'starting']);
 } finally { mkdir.mockRestore(); remove.mockRestore(); write.mockRestore(); }
});
