import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

let tempRoot = '';

function createAgentBrowserStub(root: string, logPath: string): string {
  const scriptPath = path.join(root, 'agent-browser-2fa-stub.mjs');
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
const jsonIndex = args.indexOf('--json');
const command = jsonIndex >= 0 ? args[jsonIndex + 1] : '';
const commandArgs = jsonIndex >= 0 ? args.slice(jsonIndex + 2) : [];
fs.appendFileSync(
  ${JSON.stringify(logPath)},
  JSON.stringify({ command, commandArgs }) + '\\n',
);
if (command === 'screenshot') fs.writeFileSync(commandArgs[0], 'png');
const data =
  command === 'snapshot'
    ? { snapshot: '[]', refs: {}, url: 'https://login.example.com/verify' }
    : {};
process.stdout.write(JSON.stringify({ data }));
`,
    'utf-8',
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function loggedCommands(logPath: string): string[][] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => {
      const entry = JSON.parse(line) as {
        command: string;
        commandArgs: string[];
      };
      return [entry.command, ...entry.commandArgs];
    });
}

async function loadLocalBrowserTools() {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-browser-2fa-'));
  const logPath = path.join(tempRoot, 'agent-browser.jsonl');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('AGENT_BROWSER_BIN', createAgentBrowserStub(tempRoot, logPath));
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const body = url.endsWith('/consume')
      ? { response: { kind: 'code', value: '123456' } }
      : { session: { sessionId: 'suspended-2fa', frameSnapshot: {} } };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const tools = await import('../container/src/browser-tools.js');
  tools.setBrowserGatewayContext(
    'http://127.0.0.1:4317',
    'test-token',
    '',
    'sess-local',
    'main',
  );
  return { tools, fetchMock, logPath };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  }
});

test('resume in a worker that never parked leaves the operator reply unused', async () => {
  const { tools, fetchMock, logPath } = await loadLocalBrowserTools();

  const result = JSON.parse(
    await tools.executeBrowserTool(
      'browser_resume_interaction',
      { ref: 'e5' },
      'session-a',
    ),
  ) as { success: boolean };

  expect(result.success).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(loggedCommands(logPath)).toEqual([]);
});

test('resume after a park in the same worker injects the operator code', async () => {
  const { tools, fetchMock, logPath } = await loadLocalBrowserTools();

  const parked = JSON.parse(
    await tools.executeBrowserTool(
      'browser_await_two_factor',
      { modality: 'totp' },
      'session-a',
    ),
  ) as { parked?: boolean };
  const resumed = JSON.parse(
    await tools.executeBrowserTool(
      'browser_resume_interaction',
      { ref: 'e5' },
      'session-a',
    ),
  ) as { resumed?: boolean; code_injected?: boolean };

  expect(parked.parked).toBe(true);
  expect(resumed).toMatchObject({ resumed: true, code_injected: true });
  const consumeCall = fetchMock.mock.calls.find(([url]) =>
    url.endsWith('/api/interactive-escalations/consume'),
  );
  expect(JSON.parse(String(consumeCall?.[1]?.body))).toEqual({
    sessionId: 'suspended-2fa',
  });
  expect(loggedCommands(logPath)).toContainEqual(['fill', '@e5', '123456']);
});
