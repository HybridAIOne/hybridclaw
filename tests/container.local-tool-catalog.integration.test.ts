import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { ChatMessage, ContainerInput, ContainerOutput, ToolDefinition } from '../container/src/types.js';

type RequestBody = { messages: ChatMessage[]; tools: ToolDefinition[] };
const children: ChildProcess[] = [];
const servers: http.Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve()); child.kill('SIGTERM');
  })));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function harness(replies: Array<Record<string, unknown>>, overrides: Partial<ContainerInput> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-local-catalog-ipc-')); dirs.push(dir);
  const ipc = path.join(dir, 'ipc'); fs.mkdirSync(ipc);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'synthetic tool result');
  const requests: RequestBody[] = [];
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    requests.push(JSON.parse(text));
    const message = replies.shift() ?? { role: 'assistant', content: 'done' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'test', choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test port');
  const child = spawn(process.execPath, ['--import', 'tsx', 'container/src/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: dir, HYBRIDCLAW_DATA_DIR: dir, HYBRIDCLAW_AGENT_WORKSPACE_ROOT: dir, HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT: dir, HYBRIDCLAW_AGENT_IPC_DIR: ipc, CONTAINER_IDLE_TIMEOUT: '30000' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  let errors = ''; child.stderr!.on('data', (chunk) => { errors += chunk; });
  child.stdout!.resume();
  const input: ContainerInput = {
    sessionId: 'test-session', agentId: 'test-agent', apiKey: 'test-key', baseUrl: `http://127.0.0.1:${address.port}/v1`, provider: 'mlx', isLocal: true, model: 'mlx/test', chatbotId: '', enableRag: false, channelId: 'web', ralphMaxIterations: 0, skipContainerSystemPrompt: true, persistBashState: false,
    messages: [{ role: 'user', content: 'Read the synthetic notes' }],
    ...overrides,
  };
  const waitOutput = async (): Promise<ContainerOutput> => {
    const outputPath = path.join(ipc, 'output.json');
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      if (fs.existsSync(outputPath)) {
        const result = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as ContainerOutput;
        fs.unlinkSync(outputPath); return result;
      }
      if (child.exitCode !== null) throw new Error(errors);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Runtime did not return output: ${errors}`);
  };
  child.stdin!.write(`${JSON.stringify(input)}\n`);
  return { requests, output: await waitOutput(), dir, followup: async (patch: Partial<ContainerInput>) => {
    fs.writeFileSync(path.join(ipc, 'input.json'), JSON.stringify({ ...input, ...patch }));
    return waitOutput();
  } };
}
function catalog(action: string, name?: string, args?: Record<string, unknown>): Record<string, unknown> {
  return { role: 'assistant', content: null, tool_calls: [{ id: `call_${action}`, type: 'function', function: { name: 'tool_catalog', arguments: JSON.stringify({ action, name, arguments: args }) } }] };
}

describe('local catalog through real agent IPC and model HTTP', () => {
  test('reduces 114 schemas to ten and preserves stable schemas and original call history', async () => {
    const pluginTools = Array.from({ length: 71 }, (_, i) => ({ name: `plugin_${i}`, description: 'synthetic plugin', parameters: { type: 'object' as const, properties: {}, required: [] } }));
    const { requests, output, followup } = await harness([
      catalog('list'), catalog('describe', 'read'), catalog('call', 'read', { path: 'notes.txt' }),
    ], { pluginTools });
    expect(output.status).toBe('success');
    expect(requests).toHaveLength(4);
    for (const request of requests) { expect(request.tools).toHaveLength(10); expect(request.tools).toEqual(requests[0].tools); }
    expect(JSON.parse(String(requests[1].messages.at(-1)?.content)).total).toBe(105);
    expect(output.toolExecutions?.at(-1)).toMatchObject({ name: 'read', arguments: '{"path":"notes.txt"}', isError: false, approvalTier: 'green' });
    expect(requests[3].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_call', content: expect.stringContaining('synthetic tool result') });
    expect(requests[3].messages.at(-2)?.tool_calls?.[0].function.name).toBe('tool_catalog');
    const next = await followup({ localStarterTools: ['memory'] });
    expect(next.status).toBe('success');
    expect(requests.at(-1)?.tools.map((t) => t.function.name)).toEqual(['memory', 'tool_catalog']);
    await followup({ localToolMode: 'full' });
    expect(requests.at(-1)?.tools).toHaveLength(114);
    expect(requests.at(-1)?.tools.some((t) => t.function.name === 'tool_catalog')).toBe(false);
    await followup({ localToolMode: 'starred', localStarterTools: [] });
    expect(requests.at(-1)?.tools.map((t) => t.function.name)).toEqual(['tool_catalog']);
    await followup({ isLocal: false });
    expect(requests.at(-1)?.tools).toHaveLength(114);
  });
  test.each(['starred', 'full'] as const)('denies a catalog target removed by the request block list in %s mode', async (localToolMode) => {
    const { output } = await harness([catalog('call', 'read', { path: 'notes.txt' })], { localToolMode, blockedTools: ['read'] });
    expect(output.status).toBe('error'); expect(output.error).toContain('not available');
    expect(output.toolExecutions).toEqual([]);
  });
  test('runs the existing security hook under the underlying action name', async () => {
    const { output, dir } = await harness([catalog('call', 'write', { path: 'bad.pdf', contents: 'plain text' })]);
    expect(output.toolExecutions?.[0]).toMatchObject({ name: 'write', blocked: true, isError: true, blockedReason: expect.stringContaining('binary Office/PDF') });
    expect(fs.existsSync(path.join(dir, 'bad.pdf'))).toBe(false);
  });
  test('presents approval for the real destructive action', async () => {
    const { output, followup, requests } = await harness([catalog('call', 'bash', { command: 'rm -rf scratch' })]);
    expect(output.pendingApproval).toMatchObject({ toolName: 'bash', approvalTier: 'red' });
    expect(output.toolExecutions?.[0]).toMatchObject({ name: 'bash', blocked: true, approvalDecision: 'required' });
    const replay = await followup({ messages: [{ role: 'user', content: 'yes' }], blockedTools: ['bash'] });
    expect(replay.error).toContain('no longer available');
    expect(requests).toHaveLength(1);
  });
});
