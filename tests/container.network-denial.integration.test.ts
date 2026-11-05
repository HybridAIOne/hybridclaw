import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const run = useContainerAgentHarness();
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
});

function call(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

const denied = call('denied', 'http_request', { url: 'http://127.0.0.1:9123/health' });
const policy = JSON.stringify({ network: {
  default: 'deny',
  rules: [{ action: 'deny', host: '*', port: '*', methods: ['*'], paths: ['/**'] }],
} });
const options = { prepare: async (dir: string) => {
  fs.mkdirSync(path.join(dir, '.hybridclaw'));
  fs.writeFileSync(path.join(dir, '.hybridclaw/policy.yaml'), policy);
  return {};
} };

test('a denied network probe permits independent work and skips its stale sibling', async () => {
  const worker = await run([
    { role: 'assistant', content: null, tool_calls: [denied,
      call('stale', 'write', { path: 'stale.txt', contents: 'must not run' })] },
    { role: 'assistant', content: null, tool_calls: [
      call('permitted', 'write', { path: 'report.txt', contents: 'local result' })] },
    { role: 'assistant', content: 'Local report saved; the network probe was denied.' },
  ], { approvalMode: 'full' }, {}, options);
  expect(worker.output.result).toContain('Local report saved');
  expect(worker.output.pendingApproval).toBeUndefined();
  expect(worker.output.toolExecutions?.[0]).toMatchObject({
    name: 'http_request', blocked: true, isError: true, approvalDecision: 'denied',
  });
  expect(worker.output.toolExecutions?.at(-1)).toMatchObject({ name: 'write', isError: false });
  expect(fs.readFileSync(path.join(worker.dir, 'report.txt'), 'utf8')).toBe('local result');
  expect(fs.existsSync(path.join(worker.dir, 'stale.txt'))).toBe(false);
  expect(worker.requests[1].messages?.filter((message) => message.role === 'tool')
    .map((message) => message.tool_call_id)).toEqual(['denied', 'stale']);
});

test('a repeated denied destination still stops and never executes', async () => {
  const worker = await run([
    { role: 'assistant', content: null, tool_calls: [denied] },
    { role: 'assistant', content: null, tool_calls: [denied] },
    { role: 'assistant', content: 'Must not be reached.' },
  ], { approvalMode: 'full' }, {}, options);
  expect(worker.requests).toHaveLength(2);
  expect(worker.output.toolExecutions?.map((entry) => [entry.blocked, entry.approvalDecision]))
    .toEqual([[true, 'denied'], [true, 'denied']]);
});

test('network and shell denials share one replan budget', async () => {
  const worker = await run([
    { role: 'assistant', content: null, tool_calls: [denied] },
    { role: 'assistant', content: null, tool_calls: [call('cleanup', 'bash', { command: 'rm -f keep.txt' })] },
    { role: 'assistant', content: null, tool_calls: [call('unreached', 'write', { path: 'unreached.txt', contents: 'must not run' })] },
  ], { approvalMode: 'full' }, { 'keep.txt': 'preserve me' }, options);
  expect(worker.requests).toHaveLength(2);
  expect(worker.output.toolExecutions?.map((entry) => entry.approvalDecision))
    .toEqual(['denied', 'denied']);
  expect(fs.readFileSync(path.join(worker.dir, 'keep.txt'), 'utf8')).toBe('preserve me');
  expect(fs.existsSync(path.join(worker.dir, 'unreached.txt'))).toBe(false);
});

test('network replanning does not grant a protected-file approval', async () => {
  const worker = await run([
    { role: 'assistant', content: null, tool_calls: [denied] },
    { role: 'assistant', content: null, tool_calls: [call('protected', 'read', { path: '.env' })] },
  ], { approvalMode: 'full' }, { '.env': 'TOKEN=test-key' }, options);
  expect(worker.output.pendingApproval).toMatchObject({ toolName: 'read', allowSession: false });
  expect(worker.output.toolExecutions?.map((entry) => entry.approvalDecision))
    .toEqual(['denied', 'required']);
  expect(worker.output.result).not.toContain('TOKEN=test-key');
});

test('a different allowed operation on the same host still requires its matching rule', async () => {
  const received: Array<[string | undefined, string | undefined]> = [];
  const server = http.createServer((req, res) => {
    received.push([req.method, req.url]);
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: [{ id: 'item_a' }] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  const url = `http://127.0.0.1:${address.port}`;
  const worker = await run([
    { role: 'assistant', content: null, tool_calls: [call('health', 'http_request', { url: `${url}/health` })] },
    { role: 'assistant', content: null, tool_calls: [call('items', 'bash', { command: `curl -s -X POST ${url}/api/items` })] },
    { role: 'assistant', content: 'Read the permitted collection.' },
  ], { approvalMode: 'full' }, {}, { prepare: async (dir) => {
    fs.mkdirSync(path.join(dir, '.hybridclaw'));
    fs.writeFileSync(path.join(dir, '.hybridclaw/policy.yaml'), JSON.stringify({ network: {
      default: 'deny', rules: [
        { action: 'allow', host: '127.0.0.1', port: address.port, methods: ['POST'], paths: ['/api/items'] },
        { action: 'deny', host: '*', port: '*', methods: ['*'], paths: ['/**'] },
      ],
    } }));
    return {};
  } });
  expect(worker.output.result).toBe('Read the permitted collection.');
  expect(worker.output.toolExecutions?.at(-1)).toMatchObject({ name: 'bash', isError: false });
  expect(received).toEqual([['POST', '/api/items']]);
  expect(worker.output.toolExecutions?.map((entry) => [entry.approvalDecision, entry.isError]))
    .toEqual([['denied', true], ['auto', false]]);
});
