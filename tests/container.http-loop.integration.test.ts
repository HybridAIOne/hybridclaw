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

test.each([{ items: [] }, { items: [{ id: 'existing_item' }] }])(
  'unchanged HTTP collections stop before a fourth request and permit replanning: %j',
  async ({ items }) => {
    let requests = 0;
    const server = http.createServer((req, res) => {
      requests++;
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json', Date: new Date(requests * 1000).toUTCString() });
      res.end(JSON.stringify({
        ok: true, status: 200, headers: { date: String(requests) },
        json: { items, total: items.length },
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture port');
    const tool = (id: string, name: string, args: Record<string, unknown>) => ({
      role: 'assistant', content: null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    });
    const replies: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 4; i++) {
      replies.push(tool(`read_${i}`, 'http_request', { url: `http://127.0.0.1:${address.port}/api/items` }));
      if (i < 3) replies.push(tool(`wait_${i}`, 'bash', { command: 'sleep 0' }));
    }
    replies.push(tool('report', 'write', { path: 'report.txt', contents: 'No new records; target needs verification.' }));
    replies.push({ role: 'assistant', content: 'Stopped unchanged polling.' });
    const worker = await run(replies, {
      approvalMode: 'full', gatewayBaseUrl: `http://127.0.0.1:${address.port}`,
    }, {}, { prepare: async (dir) => {
      fs.mkdirSync(path.join(dir, '.hybridclaw'));
      fs.writeFileSync(path.join(dir, '.hybridclaw/policy.yaml'), JSON.stringify({ network: {
        default: 'deny', rules: [
          { action: 'allow', host: '127.0.0.1', port: address.port, methods: ['GET'], paths: ['/api/items'] },
          { action: 'deny', host: '*', port: '*', methods: ['*'], paths: ['/**'] },
        ],
      } }));
      return {};
    } });
    expect(requests, worker.stderr()).toBe(3);
    const reads = worker.output.toolExecutions?.filter((entry) => entry.name === 'http_request');
    expect(reads).toHaveLength(4);
    expect(reads?.map((entry) => entry.isError)).toEqual([false, false, false, true]);
    expect(worker.output.result).toBe('Stopped unchanged polling.');
    expect(fs.readFileSync(path.join(worker.dir, 'report.txt'), 'utf8')).toContain('No new records');
  },
);
