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
    res.end(JSON.stringify({ id: 'test', choices: [{ message, finish_reason: message.finish_reason ?? (message.tool_calls ? 'tool_calls' : 'stop') }] }));
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
  return { role: 'assistant', content: null, tool_calls: [{ id: `call_${action}`, type: 'function', function: { name: 'tool_catalog', arguments: JSON.stringify({ action, name: name ?? (action === 'list' ? '' : undefined), arguments: args }) } }] };
}

describe('local catalog through real agent IPC and model HTTP', () => {
  test('reduces 114 schemas to ten and preserves stable schemas and original call history', async () => {
    const pluginTools = Array.from({ length: 71 }, (_, i) => ({ name: `plugin_${i}`, description: 'synthetic plugin', parameters: { type: 'object' as const, properties: {}, required: [] } }));
    const { requests, output, followup } = await harness([
      catalog('list'), catalog('describe', 'read'), catalog('call', 'read', { path: 'notes.txt' }),
    ], { pluginTools });
    expect(output.status).toBe('success');
    expect(requests).toHaveLength(4);
    const system = requests[0].messages.filter((message) => message.role === 'system');
    expect(system.map((message) => message.content).join('\n')).toContain('## Local tool call boundary');
    for (const request of requests) {
      expect(request.messages.filter((message) => message.role === 'system')).toEqual(system);
    }
    for (const request of requests) { expect(request.tools).toHaveLength(10); expect(request.tools).toEqual(requests[0].tools); }
    expect(JSON.parse(String(requests[1].messages.at(-1)?.content)).total).toBe(105);
    expect(output.toolExecutions?.at(-1)).toMatchObject({ name: 'read', arguments: '{"path":"notes.txt"}', isError: false, approvalTier: 'green' });
    expect(requests[3].messages.filter((message) => String(message.content).includes('## Local tool call boundary'))).toHaveLength(1);
    expect(requests[3].messages.some((message) => String(message.content).includes('Runtime tool reminder:'))).toBe(false);
    expect(requests[3].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_call', content: expect.stringContaining('synthetic tool result') });
    expect(requests[3].messages.at(-2)?.tool_calls?.[0].function.name).toBe('tool_catalog');
    expect(output.toolHistory?.map((message) => message.role)).toEqual(['assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool']);
    expect(output.toolHistory?.filter((message) => message.role === 'assistant').every((message) => message.tool_calls?.[0].function.name === 'tool_catalog')).toBe(true);
    expect(output.toolHistory?.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_call', content: expect.stringContaining('synthetic tool result') });
    expect(output.toolHistoryForReplay).toEqual(output.toolHistory);
    for (let i = 1; i < 4; i++) expect(requests[i].messages.slice(0, requests[i - 1].messages.length)).toEqual(requests[i - 1].messages);
    const next = await followup({ localStarterTools: ['memory'] });
    expect(next.status).toBe('success');
    expect(requests.at(-1)?.tools.map((t) => t.function.name)).toEqual(['memory', 'tool_catalog']);
    expect(requests.at(-1)?.messages[0].content).toContain('Directly exposed functions in this request are memory and tool_catalog.');
    expect(requests.at(-1)?.messages[0].content).toContain('their own schemas do not need to be directly exposed');
    await followup({ localToolMode: 'full' });
    expect(requests.at(-1)?.tools).toHaveLength(114);
    expect(requests.at(-1)?.tools.some((t) => t.function.name === 'tool_catalog')).toBe(false);
    expect(requests.at(-1)?.messages[0].content).not.toContain('## Local tool call boundary');
    expect(requests.at(-1)?.messages.some((m) => String(m.content).includes('Runtime tool reminder:'))).toBe(false);
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


test('recovers a skill-name lookup through the catalog with two stable schemas', async () => {
  const { output, requests } = await harness([
    catalog('list'), catalog('describe', 'pdf'), catalog('describe', 'read'),
    catalog('call', 'read', { path: 'notes.txt' }),
  ], { localStarterTools: ['skills_list'] });
  expect(output.status).toBe('success');
  expect(output.toolExecutions?.map((entry) => [entry.name, entry.isError])).toEqual([
    ['tool_catalog', false], ['tool_catalog', true], ['tool_catalog', false], ['read', false],
  ]);
  expect(requests).toHaveLength(5);
  expect(requests[2].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_describe', content: expect.stringContaining('Skill names and file paths are not tool names') });
  expect(requests[2].messages.at(-2)?.tool_calls?.[0].function.arguments).toBe('{"action":"describe","name":"pdf"}');
  expect(output.toolExecutions?.at(-1)?.result).toContain('synthetic tool result');
  for (const request of requests) {
    expect(request.tools.map((t) => t.function.name)).toEqual(['skills_list', 'tool_catalog']);
    expect(request.tools).toEqual(requests[0].tools);
    expect(request.messages.filter((m) => m.role === 'system')).toEqual(requests[0].messages.filter((m) => m.role === 'system'));
  }
});

test('stops repeated missing descriptions and still rejects unavailable actions', async () => {
  const { output, requests } = await harness([
    catalog('describe', 'pdf'), catalog('describe', 'pdf'), catalog('describe', 'pdf'),
  ], { localStarterTools: ['skills_list'] });
  expect(output.status).toBe('error');
  expect(output.error).toContain('not available');
  expect(requests).toHaveLength(3);
  expect(output.toolExecutions).toHaveLength(2);
  expect(output.toolExecutions?.every((entry) => entry.isError)).toBe(true);
  const blocked = await harness([
    catalog('describe', 'read'), catalog('call', 'read', { path: 'notes.txt' }),
  ], { localStarterTools: ['skills_list'], blockedTools: ['read'] });
  expect(blocked.output.status).toBe('error');
  expect(blocked.output.toolExecutions).toHaveLength(1);
  expect(blocked.output.toolExecutions?.[0]).toMatchObject({ name: 'tool_catalog', isError: true });
  expect(blocked.output.error).toContain('not available');
});


test('rejects a malformed catalog batch before any sibling executes and allows a corrected call', async () => {
  const invalid = catalog('call', undefined, { path: 'notes.txt' });
  const sibling = catalog('call', 'write', { path: 'must-not-exist.txt', contents: 'not executed' });
  const mixed = { ...invalid, tool_calls: [
    ...((sibling.tool_calls as Array<Record<string, unknown>>).map((call) => ({ ...call, id: 'valid-sibling' }))),
    ...(invalid.tool_calls as Array<Record<string, unknown>>),
  ] };
  const { output, requests, dir } = await harness([
    mixed, catalog('call', 'read', { path: 'notes.txt' }),
  ], { localStarterTools: ['skills_list'] });
  expect(output.status).toBe('success');
  expect(fs.existsSync(path.join(dir, 'must-not-exist.txt'))).toBe(false);
  expect(output.toolExecutions?.slice(0, 2).every((entry) => entry.name === 'tool_catalog' && entry.isError && entry.blocked)).toBe(true);
  expect(output.toolExecutions?.at(-1)).toMatchObject({ name: 'read', isError: false });
  expect(requests[1].messages.slice(-2).every((m) => m.role === 'tool' && String(m.content).includes('No tool in this batch was executed'))).toBe(true);
  expect(requests[1].tools).toEqual(requests[0].tools);
  expect(output.toolHistory?.[0].tool_calls).toEqual(mixed.tool_calls);
  expect(output.toolHistory?.slice(1, 3)).toEqual(requests[1].messages.slice(-2));
  expect(output.toolHistory?.slice(1, 3).every((message) => String(message.content).includes('No tool in this batch was executed'))).toBe(true);
  expect(output.toolHistoryForReplay).toEqual(output.toolHistory);
});

test('shares the correction budget across missing descriptions and malformed calls', async () => {
  const { output, requests } = await harness([
    catalog('describe', 'pdf'), catalog('call', undefined, {}), catalog('call', undefined, {}),
  ], { localStarterTools: ['skills_list'] });
  expect(output.status).toBe('error');
  expect(output.error).toContain('top-level name');
  expect(requests).toHaveLength(3);
  expect(output.toolExecutions).toHaveLength(2);
  const full = await harness([catalog('call', undefined, {})], { localToolMode: 'full' });
  expect(full.output.status).toBe('error');
  expect(full.requests).toHaveLength(1);
});


test('adds no catalog reminder after a directly exposed starter call', async () => {
  const direct = { role: 'assistant', content: null, tool_calls: [{ id: 'direct-read', type: 'function', function: { name: 'read', arguments: '{"path":"notes.txt"}' } }] };
  const { requests, output } = await harness([direct]);
  expect(output.status).toBe('success');
  expect(requests[1].messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('synthetic tool result') });
  expect(requests[1].messages.some((m) => String(m.content).includes('Runtime tool reminder:'))).toBe(false);
});


test('follows staged skill summaries, details, and approved reading with fixed schemas', async () => {
  const { output, requests, followup } = await harness([
    catalog('call', 'skills_list', { query: 'PDF create' }),
    catalog('call', 'skills_list', { name: 'pdf' }),
    catalog('call', 'read', { path: 'notes.txt' }),
  ], { localStarterTools: [], allowedTools: ['read', 'skills_list'], skillCatalog: [{ name: 'pdf', description: 'Create PDF files.', category: 'office', location: 'notes.txt' }] });
  expect(output.status).toBe('success');
  const records = output.toolExecutions!;
  expect(JSON.parse(records[0].result).skills[0].next).toEqual({ name: 'tool_catalog', arguments: { action: 'call', name: 'skills_list', arguments: { name: 'pdf' } } });
  expect(JSON.parse(records[1].result)).toMatchObject({ instructionsLoaded: false, next: { name: 'tool_catalog', arguments: { action: 'call', name: 'read', arguments: { path: 'notes.txt' } } } });
  expect(records[2]).toMatchObject({ name: 'read', approvalTier: 'green', isError: false, result: expect.stringContaining('synthetic tool result') });
  for (let index = 1; index < requests.length; index++) {
    expect(requests[index].tools).toEqual(requests[0].tools);
    expect(requests[index].messages.slice(0, requests[index - 1].messages.length)).toEqual(requests[index - 1].messages);
  }
  await followup({ skillCatalog: [], blockedTools: ['read'] });
  expect(requests.at(-1)?.tools.map((tool) => tool.function.name)).toEqual(['tool_catalog']);
});

test('rejects wrong underlying arguments before a valid sibling write and recovers', async () => {
  const invalid = catalog('call', 'bash', { path: 'private-placeholder' });
  const sibling = catalog('call', 'write', { path: 'must-not-exist.txt', contents: 'not executed' });
  const { output, dir, requests } = await harness([
    { role: 'assistant', content: null, tool_calls: [...(sibling.tool_calls as Array<Record<string, unknown>>).map((call) => ({ ...call, id: 'valid-write' })), ...invalid.tool_calls as object[]] },
    catalog('describe', 'bash'), catalog('call', 'bash', { command: 'pwd' }),
  ], { localStarterTools: ['skills_list'] });
  expect(output.status).toBe('success');
  expect(fs.existsSync(path.join(dir, 'must-not-exist.txt'))).toBe(false);
  expect(output.toolExecutions?.slice(0, 2).every((tool) => tool.blocked && tool.isError)).toBe(true);
  expect(requests[1].messages.slice(-2).every((message) => String(message.content).includes('Arguments do not match'))).toBe(true);
  expect(output.toolExecutions?.at(-1)).toMatchObject({ name: 'bash', isError: false, approvalTier: 'green' });
});


test('recovers mixed exposed calls without executing a valid starter sibling', async () => {
  const direct = { id: 'starter-write', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'must-not-exist.txt', contents: 'not executed' }) } };
  const invalid = catalog('call', undefined, {});
  const { output, dir, requests } = await harness([
    { role: 'assistant', content: null, tool_calls: [direct, ...invalid.tool_calls as object[]] },
    catalog('call', 'read', { path: 'notes.txt' }),
  ], { localStarterTools: ['write'] });
  expect(output.status).toBe('success');
  expect(fs.existsSync(path.join(dir, 'must-not-exist.txt'))).toBe(false);
  expect(output.toolExecutions?.slice(0, 2).map((tool) => [tool.name, tool.blocked, tool.isError])).toEqual([['write', true, true], ['tool_catalog', true, true]]);
  expect(requests[1].messages.slice(-2).every((message) => String(message.content).includes('No tool in this batch was executed'))).toBe(true);
  expect(output.toolExecutions?.at(-1)).toMatchObject({ name: 'read', isError: false });
});

test('never recovers a mixed batch containing an unexposed direct function', async () => {
  const direct = { id: 'unexposed-write', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'must-not-exist.txt', contents: 'not executed' }) } };
  const invalid = catalog('call', undefined, {});
  const { output, dir, requests } = await harness([
    { role: 'assistant', content: null, tool_calls: [...invalid.tool_calls as object[], direct] },
  ], { localStarterTools: ['skills_list'] });
  expect(output.status).toBe('error');
  expect(output.toolExecutions).toEqual([]);
  expect(requests).toHaveLength(1);
  expect(fs.existsSync(path.join(dir, 'must-not-exist.txt'))).toBe(false);
});


test.each(['length', 'stop'])('never marks reasoning-only local output as completed (%s)', async (finish_reason) => {
  const { output, requests } = await harness([
    catalog('call', 'read', { path: 'notes.txt' }),
    { role: 'assistant', content: '<think>I still need to create the PDF', finish_reason },
  ], { localStarterTools: ['skills_list'] });
  expect(requests).toHaveLength(2);
  expect(output.status).toBe('error');
  expect(output.result).toBeNull();
  expect(output.artifacts ?? []).toEqual([]);
  expect(output.toolExecutions).toHaveLength(1);
  expect(output.error).toContain(finish_reason === 'length' ? 'output-token limit' : 'no final answer');
});

test('keeps valid tool calls following reasoning instead of treating them as empty output', async () => {
  const response = { ...catalog('call', 'read', { path: 'notes.txt' }), content: '<think>Read the file first.</think>' };
  const { output, requests } = await harness([response, { role: 'assistant', content: 'Read completed.' }], { localStarterTools: ['skills_list'] });
  expect(requests).toHaveLength(2);
  expect(output.status).toBe('success');
  expect(output.result).toBe('Read completed.');
  expect(output.toolExecutions?.[0]).toMatchObject({ name: 'read', isError: false });
});


test('replays local tool history with catalog guidance and strips foreign provider metadata', async () => {
  const messages: ChatMessage[] = [
    { role: 'assistant', content: null, tool_calls: [{
      id: 'previous-read', type: 'function', function: { name: 'read', arguments: '{"path":"notes.txt"}' },
    }],
      anthropic_content: [{ type: 'tool_use', id: 'previous-read', name: 'read', input: { path: 'notes.txt' } }],
      openai_response_items: [{ type: 'reasoning', id: 'reasoning_a', summary: [] }],
    },
    { role: 'tool', tool_call_id: 'previous-read', content: 'Previously read notes.' },
    { role: 'user', content: 'Use the previous result.' },
  ];
  const original = structuredClone(messages);
  const { output, requests } = await harness([], { messages, localStarterTools: ['skills_list'] });
  expect(output.status).toBe('success');
  expect(requests).toHaveLength(1);
  const request = requests[0];
  expect(request.tools.map((tool) => tool.function.name)).toEqual(['skills_list', 'tool_catalog']);
  expect(request.messages[0].content).toContain('Additional permitted tools are available through tool_catalog');
  expect(request.messages.find((message) => message.role === 'assistant')?.tool_calls).toEqual(original[0].tool_calls);
  expect(request.messages.find((message) => message.role === 'tool')).toEqual(original[1]);
  expect(request.messages.every((message) => !message.anthropic_content && !message.openai_response_items)).toBe(true);
  expect(output.toolExecutions).toEqual([]);
  expect(messages).toEqual(original);
});
