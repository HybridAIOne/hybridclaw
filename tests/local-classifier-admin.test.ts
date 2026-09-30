import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, test, vi } from 'vitest';
import { handleLocalClassifierAdmin } from '../src/gateway/local-classifier-admin.js';
import { clearLocalClassifiers, registerLocalClassifier } from '../src/routing/local-classifiers.js';
afterEach(clearLocalClassifiers);
function register() {
 const command = vi.fn();
 registerLocalClassifier({model:'local-decision/laya',label:'Laya',status:()=>({supported:true,installed:false,status:'stopped'}),command,predict:vi.fn()}); return command;
}
async function request(method: string, body: unknown, local = true) {
 const req = Readable.from([JSON.stringify(body)]) as IncomingMessage; req.method = method;
 const res = {statusCode:0,headersSent:false,writableEnded:false,setHeader:vi.fn(),end:vi.fn()} as unknown as ServerResponse;
 await handleLocalClassifierAdmin(req,res,local); return res;
}
test('lists real runtime state', async()=>{register(); const res=await request('GET',{});expect(res.statusCode).toBe(200);expect(JSON.parse(vi.mocked(res.end).mock.calls[0][0] as string).classifiers[0]).toMatchObject({model:'local-decision/laya',installed:false,status:'stopped'});});
test.each(['setup','start','stop'])('dispatches %s only on loopback',async action=>{ const command=register();expect((await request('POST',{model:'local-decision/laya',action},false)).statusCode).toBe(403);expect(command).not.toHaveBeenCalled();expect((await request('POST',{model:'local-decision/laya',action})).statusCode).toBe(202);expect(command).toHaveBeenCalledWith(action);});
test.each([{model:'unknown',action:'start'},{model:'local-decision/laya',action:'shell'},null])('rejects invalid control input', async body=>{const command=register();expect((await request('POST',body)).statusCode).toBe(400);expect(command).not.toHaveBeenCalled();});
test('does not reveal runtime errors',async()=>{const command=register();command.mockImplementation(()=>{throw new Error('private path');});const res=await request('POST',{model:'local-decision/laya',action:'start'});expect(res.statusCode).toBe(409);expect(vi.mocked(res.end).mock.calls[0][0]).not.toContain('private path');});
