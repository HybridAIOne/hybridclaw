import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();

test.each(['read', 'execute'] as const)(
  'a real worker distinguishes quoted stdin data from %s',
  async (kind) => {
    let fetches = 0;
    const payload = "open('unexpected.txt','w').write('executed')";
    const server = http.createServer((_request, response) => {
      fetches++;
      response.end(payload);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing fixture address');
      const commands = [
        `for n in one; do curl -fsS http://127.0.0.1:${address.port}/page -o "page-$n.html"; done`,
        `python3 - <<'PY'\n${kind === 'read' ? "text = open('page-one.html').read()\nprint(text)" : "exec(open('page-one.html').read())"}\nPY`,
      ];
      const replies: Record<string, unknown>[] = commands.map((command, index) => ({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `call-${index}`,
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ command }) },
        }],
      }));
      replies.push({ role: 'assistant', content: 'Finished permitted work.' });
      const run = await runAgent(replies, { approvalMode: 'full' });
      expect(fetches).toBe(1);
      expect(fs.existsSync(path.join(run.dir, 'unexpected.txt'))).toBe(false);
      if (kind === 'read') {
        expect(run.output.pendingApproval).toBeUndefined();
        expect(run.output.status).toBe('success');
        expect(run.output.toolExecutions?.at(-1)).toMatchObject({
          name: 'bash', isError: false,
          result: expect.stringContaining(payload),
        });
      } else {
        expect(run.output.pendingApproval).toBeDefined();
        expect(run.output.toolExecutions?.at(-1)?.approvalActionKey)
          .toBe('bash:fetched-code');
      }
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  },
  20000,
);
