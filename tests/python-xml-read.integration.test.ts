import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';
import { useTempDir } from './test-utils.js';
const runAgent = useContainerAgentHarness();
const temporary = useTempDir('xml-scratch-');
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
  'workspace',
  'scratch',
  'custom-parser',
  'derived-code',
  'pipeline-derived-code',
] as const)(
  'a real worker handles XML %s',
  async (kind) => {
    let fetches = 0;
    const title = kind.includes('derived')
      ? "open('unexpected.txt','w').write('executed')"
      : 'Fixture entry';
    const server = http.createServer((_request, response) => {
      fetches++;
      response.writeHead(200, { 'Content-Type': 'application/xml' });
      response.end(`<feed><entry><title>${title}</title></entry></feed>`);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing fixture address');
      const file =
        kind === 'scratch' ? path.join(temporary(), 'feed.xml') : 'feed.xml';
      const reader = `import xml.etree.ElementTree as ET; print(ET.parse(${JSON.stringify(kind === 'scratch' ? 'feed.xml' : file)}).getroot().find('entry').find('title').text)`;
      const shell = `${kind === 'scratch' ? `cd ${path.dirname(file)} && ` : ''}python3 -c '${reader.replaceAll("'", "'\\''")}'`;
      const replies: Record<string, unknown>[] = [
        call(
          'download',
          `curl -fsS http://127.0.0.1:${address.port}/feed -o ${file}`,
        ),
      ];
      if (kind === 'custom-parser')
        replies.push(
          call(
            'custom',
            shell.replace(').getroot()', ',parser=ET.XMLParser()).getroot()'),
          ),
        );
      else if (kind.includes('derived'))
        replies.push(
          call(
            'extract',
            shell +
              (kind === 'pipeline-derived-code'
                ? ' | tee output.txt'
                : ' > output.txt'),
          ),
          call('execute', 'python3 output.txt'),
        );
      else replies.push(call('read', shell));
      replies.push({ role: 'assistant', content: 'Finished permitted work.' });
      const run = await runAgent(replies, { approvalMode: 'full' });
      expect(fetches).toBe(1);
      expect(fs.existsSync(path.join(run.dir, 'unexpected.txt'))).toBe(false);
      if (kind === 'workspace' || kind === 'scratch') {
        expect(run.output.pendingApproval).toBeUndefined();
        expect(run.output.status).toBe('success');
        expect(run.output.toolExecutions?.at(-1)).toMatchObject({
          name: 'bash',
          isError: false,
          result: expect.stringContaining('Fixture entry'),
        });
      } else {
        expect(run.output.pendingApproval).toBeDefined();
        expect(run.output.toolExecutions?.at(-1)?.approvalActionKey).toBe(
          'bash:fetched-code',
        );
        if (kind.includes('derived'))
          expect(
            fs.readFileSync(path.join(run.dir, 'output.txt'), 'utf8'),
          ).toContain(title);
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
