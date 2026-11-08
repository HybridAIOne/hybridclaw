import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();
function call(id: string, command: string) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name: 'bash', arguments: JSON.stringify({ command }) },
      },
    ],
  };
}

test.each([
  'data',
  'data-absolute',
  'data-stdin',
  'data-pipe',
  'stdin-execute',
  'pipe-execute',
  'execute',
  'hook',
  'interactive',
  'inspect-env',
  'interpreter',
] as const)(
  'a real worker distinguishes downloaded %s',
  async (kind) => {
    let fetches = 0;
    const server = http.createServer((_request, response) => {
      fetches++;
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end(
        kind === 'interpreter'
          ? '#!/bin/sh\nprintf executed > unexpected.txt\n'
          : [
                'execute',
                'stdin-execute',
                'pipe-execute',
                'interactive',
                'inspect-env',
              ].includes(kind)
            ? "open('unexpected.txt','w').write('executed')"
            : '{"items":[{"title":"Fixture record","url":"https://example.com"}]}',
      );
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing fixture port');
      const consumer =
        kind === 'stdin-execute'
          ? 'python3 -c "import sys; exec(sys.stdin.read())" < records.data'
          : kind === 'pipe-execute'
            ? 'cat records.data | python3 -c "import sys; exec(sys.stdin.read())"'
            : kind === 'data-stdin'
              ? 'python3 -c "import json,sys; print(json.load(sys.stdin))" < records.data'
              : kind === 'data-pipe'
                ? 'cat records.data | python3 -c "import json,sys; print(json.load(sys.stdin))"'
                : kind === 'interactive'
                  ? 'python3 -ic "print(1)" < records.data'
                  : kind === 'inspect-env'
                    ? 'PYTHONINSPECT=1 python3 -c "print(1)" < records.data'
                    : kind === 'interpreter'
                      ? 'chmod +x python3; ./python3 -c "print(1)"'
                      : kind === 'execute'
                        ? 'python3 records.data'
                        : kind === 'hook'
                          ? 'python3 -c "import json; json.load(open(\'records.data\'), object_hook=exec)"'
                          : "python3 -c \"import json\ndata=json.load(open('records.data'))\nfor item in data.get('items',[]):\n print(item.get('title'),item.get('url'))\"";
      const replies: Array<Record<string, unknown>> = [];
      const run = await runAgent(
        replies,
        { approvalMode: 'full' },
        {},
        {
          prepare: async (dir) => {
            const file =
              kind === 'data-absolute'
                ? path.join(dir, 'records.data')
                : 'records.data';
            replies.push(
              call(
                'download',
                `curl -fsS http://127.0.0.1:${address.port}/records -o ${kind === 'interpreter' ? 'python3' : file}`,
              ),
              call('consume', consumer.replaceAll('records.data', file)),
              { role: 'assistant', content: 'Finished.' },
            );
            return {};
          },
        },
      );
      expect(fetches).toBe(1);
      expect(fs.existsSync(path.join(run.dir, 'unexpected.txt'))).toBe(false);
      if (kind.startsWith('data')) {
        expect(run.output.pendingApproval).toBeUndefined();
        expect(run.output.status).toBe('success');
        expect(run.output.toolExecutions?.at(-1)).toMatchObject({
          name: 'bash',
          isError: false,
        });
        expect(run.output.toolExecutions?.at(-1)?.result).toContain(
          'Fixture record',
        );
      } else {
        expect(run.output.pendingApproval).toBeDefined();
        expect(run.output.toolExecutions?.at(-1)?.approvalActionKey).toBe(
          'bash:fetched-code',
        );
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
