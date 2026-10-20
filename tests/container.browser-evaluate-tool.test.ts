import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-browser-evaluate-');
useCleanMocks({
  restoreAllMocks: true,
  resetModules: true,
  unstubAllEnvs: true,
  unstubAllGlobals: true,
});

// agent-browser stand-in: page scripts run in a VM whose `location` is
// PAGE_URL, and every command is logged.
function createAgentBrowserStub(root: string, logPath: string): string {
  const scriptPath = path.join(root, 'agent-browser-evaluate-stub.mjs');
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import fs from 'node:fs';
import vm from 'node:vm';

const args = process.argv.slice(2);
const jsonIndex = args.indexOf('--json');
const command = args[jsonIndex + 1];
const commandArgs = args.slice(jsonIndex + 2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ command, commandArgs }) + '\\n');
const url = process.env.PAGE_URL;
if (command === 'eval') {
  try {
    const result = await vm.runInNewContext(commandArgs[0], { location: { href: url } });
    process.stdout.write(JSON.stringify({ success: true, data: { origin: url, result: result ?? null } }));
  } catch (err) {
    process.stdout.write(JSON.stringify({ success: false, data: null, error: 'Evaluation error: ' + err }));
    process.exit(1);
  }
} else {
  const data = command === 'snapshot'
    ? { snapshot: '- textbox "Password" [ref=e2]', refs: {}, url }
    : {};
  process.stdout.write(JSON.stringify({ data }));
}
`,
    'utf-8',
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

async function loadTools(pageUrl = 'https://fair.example/exhibitors') {
  const root = makeTempDir();
  const logPath = path.join(root, 'agent-browser.jsonl');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  vi.stubEnv('AGENT_BROWSER_BIN', createAgentBrowserStub(root, logPath));
  vi.stubEnv('PAGE_URL', pageUrl);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const tools = await import('../container/src/tools.js');
  tools.setGatewayContext('http://gateway.test', 'gateway-token', 'web');
  tools.setSessionContext('chat-1');
  const evaluate = async (args: Record<string, unknown>) =>
    JSON.parse(
      await tools.executeTool('browser_evaluate', JSON.stringify(args)),
    ) as Record<string, unknown>;
  const pageScripts = () =>
    fs
      .readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { command: string; commandArgs: string[] })
      .filter((entry) => entry.command === 'eval')
      .map((entry) => entry.commandArgs[0]);
  return { tools, root, evaluate, pageScripts };
}

const EXHIBITORS = `Promise.resolve(
  Array.from({ length: 2000 }, (_, i) => ({ name: 'Exhibitor ' + i, booth: 'H' + (i % 9) }))
)`;

test('returns the awaited value of the expression', async () => {
  const { evaluate } = await loadTools();

  const output = await evaluate({
    expression: "Promise.resolve([{ name: 'Acme', booth: 'H1' }])",
  });

  expect(output).toEqual({
    success: true,
    url: 'https://fair.example/exhibitors',
    result: [{ name: 'Acme', booth: 'H1' }],
  });
});

test('a large result is truncated inline and says how to get all of it', async () => {
  const { evaluate } = await loadTools();

  const output = await evaluate({ expression: EXHIBITORS });

  expect(output.truncated).toBe(true);
  expect(String(output.result)).toHaveLength(48_000);
  expect(String(output.note)).toContain('Pass path');
});

test('with a path the whole result is saved to the workspace', async () => {
  const { evaluate, root } = await loadTools();

  const json = await evaluate({ expression: EXHIBITORS, path: 'exports/exhibitors.json' });
  const csv = await evaluate({
    expression: `${EXHIBITORS}.then(rows => rows.map(r => r.name + ',' + r.booth).join('\\n'))`,
    path: 'exports/exhibitors.csv',
  });

  expect(json).toMatchObject({ success: true, path: 'exports/exhibitors.json', count: 2000 });
  const saved = JSON.parse(
    fs.readFileSync(path.join(root, 'exports/exhibitors.json'), 'utf-8'),
  ) as unknown[];
  expect(saved).toHaveLength(2000);
  expect(csv).toMatchObject({ success: true, path: 'exports/exhibitors.csv' });
  const lines = fs
    .readFileSync(path.join(root, 'exports/exhibitors.csv'), 'utf-8')
    .split('\n');
  expect(lines).toHaveLength(2000);
  expect(lines[1999]).toBe('Exhibitor 1999,H1');
});

test('an exception in the page comes back as a tool error with its message', async () => {
  const { tools } = await loadTools();

  const output = await tools.executeTool(
    'browser_evaluate',
    JSON.stringify({ expression: "Promise.reject(new Error('list not loaded'))" }),
  );

  expect(output).toMatch(/^Error: .*list not loaded/s);
});

test('a secret typed into the page cannot be read back by a page script', async () => {
  const { tools, pageScripts } = await loadTools();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, value: 'pw-cleartext-secret' })),
    ),
  );
  await tools.executeTool(
    'browser_secret_type',
    JSON.stringify({ ref: 'e2', secretName: 'FAIR_PASSWORD' }),
  );

  const output = await tools.executeTool(
    'browser_evaluate',
    JSON.stringify({ expression: "document.querySelector('input').value" }),
  );

  expect(output).toMatch(/^Error: A secret was typed into this page/);
  expect(output).not.toContain('pw-cleartext-secret');
  expect(pageScripts()).not.toContain("document.querySelector('input').value");
});

test('a page on a private host runs no script unless private hosts are allowed', async () => {
  const { tools, pageScripts } = await loadTools('http://127.0.0.1:8080/admin');

  const output = await tools.executeTool(
    'browser_evaluate',
    JSON.stringify({ expression: "fetch('/api/reboot', { method: 'POST' })" }),
  );

  expect(output).toContain('private or loopback host (127.0.0.1)');
  expect(pageScripts()).toEqual(['location.href']);
});
