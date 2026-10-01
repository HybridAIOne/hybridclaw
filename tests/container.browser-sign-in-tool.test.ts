import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

let tempRoot = '';

// agent-browser stand-in: every page is the login page; typing is logged.
function createAgentBrowserStub(root: string, logPath: string): string {
  const scriptPath = path.join(root, 'agent-browser-sign-in-stub.mjs');
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
const data =
  command === 'snapshot'
    ? {
        snapshot: '- textbox "Email" [ref=e1]\\n- textbox "Password" [ref=e2]',
        refs: {},
        url: 'https://hybridai.one/login?next=%2Fchat',
      }
    : {};
process.stdout.write(JSON.stringify({ data }));
`,
    'utf-8',
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function typedTexts(logPath: string): string[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { command: string; commandArgs: string[] })
    .filter((entry) => entry.command === 'fill' || entry.command === 'type')
    .map((entry) => entry.commandArgs.at(-1) || '');
}

async function loadTools(saved: Record<string, unknown>) {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-sign-in-tool-'));
  const logPath = path.join(tempRoot, 'agent-browser.jsonl');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('AGENT_BROWSER_BIN', createAgentBrowserStub(tempRoot, logPath));
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      requests.push({ url, body });
      if (url.endsWith('/api/browser/sign-in')) {
        return new Response(JSON.stringify(saved));
      }
      if (url.endsWith('/api/secret/inject')) {
        const value =
          body.secretName === 'SIGNIN_HYBRIDAI_ONE_USERNAME'
            ? 'ben@example.com'
            : 'pw-cleartext-secret';
        return new Response(JSON.stringify({ ok: true, value }));
      }
      return new Response('{}', { status: 404 });
    }),
  );
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const tools = await import('../container/src/tools.js');
  tools.setGatewayContext('http://gateway.test', 'gateway-token', 'web');
  tools.setSessionContext('chat-1');
  return { tools, requests, stderr, logPath };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  }
});

test('without a saved sign-in the tool asks the app for one and says to stop', async () => {
  const { tools, requests, stderr, logPath } = await loadTools({
    saved: false,
    host: 'hybridai.one',
  });

  const output = JSON.parse(
    await tools.executeTool(
      'browser_sign_in',
      JSON.stringify({ username_ref: 'e1', password_ref: 'e2' }),
    ),
  ) as Record<string, unknown>;

  expect(requests).toEqual([
    {
      url: 'http://gateway.test/api/browser/sign-in',
      body: { host: 'hybridai.one' },
    },
  ]);
  expect(output).toMatchObject({
    success: true,
    host: 'hybridai.one',
    sign_in_requested: true,
  });
  expect(String(output.next)).toContain('Never ask for a username, password');
  // The ask rides on a frame line: no query, no picture.
  const frameLines = stderr.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith('[browser-frame] '));
  expect(frameLines.map((line) => JSON.parse(line.slice(16)))).toEqual([
    {
      url: 'https://hybridai.one/login',
      title: '',
      signIn: { host: 'hybridai.one' },
    },
  ]);
  expect(typedTexts(logPath)).toEqual([]);
});

test('a saved sign-in is typed into the named fields without reaching the output', async () => {
  const { tools, requests, logPath } = await loadTools({
    saved: true,
    host: 'hybridai.one',
    usernameSecret: 'SIGNIN_HYBRIDAI_ONE_USERNAME',
    passwordSecret: 'SIGNIN_HYBRIDAI_ONE_PASSWORD',
  });

  const output = await tools.executeTool(
    'browser_sign_in',
    JSON.stringify({ username_ref: 'e1', password_ref: 'e2' }),
  );

  expect(JSON.parse(output)).toMatchObject({
    success: true,
    host: 'hybridai.one',
    filled: ['username', 'password'],
  });
  expect(output).not.toContain('pw-cleartext-secret');
  expect(output).not.toContain('ben@example.com');
  expect(
    requests
      .filter((request) => request.url.endsWith('/api/secret/inject'))
      .map((request) => request.body),
  ).toEqual([
    expect.objectContaining({
      secretName: 'SIGNIN_HYBRIDAI_ONE_USERNAME',
      host: 'hybridai.one',
      sinkKind: 'dom',
      sessionId: 'chat-1',
    }),
    expect.objectContaining({
      secretName: 'SIGNIN_HYBRIDAI_ONE_PASSWORD',
      host: 'hybridai.one',
      sinkKind: 'dom',
      sessionId: 'chat-1',
    }),
  ]);
  expect(typedTexts(logPath)).toEqual([
    'ben@example.com',
    'pw-cleartext-secret',
  ]);
});

test('replace asks again even when a sign-in is saved', async () => {
  const { tools, requests } = await loadTools({
    saved: true,
    host: 'hybridai.one',
    passwordSecret: 'SIGNIN_HYBRIDAI_ONE_PASSWORD',
  });

  const output = JSON.parse(
    await tools.executeTool(
      'browser_sign_in',
      JSON.stringify({ password_ref: 'e2', replace: true }),
    ),
  ) as Record<string, unknown>;

  expect(output.sign_in_requested).toBe(true);
  expect(String(output.next)).toContain('No working sign-in');
  expect(requests).toEqual([]);
});
