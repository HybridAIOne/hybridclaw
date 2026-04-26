import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

let tempRoot = '';

function createAgentBrowserStub(root: string): string {
  const scriptPath = path.join(root, 'agent-browser-stub.mjs');
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const jsonIndex = args.indexOf('--json');
const command = jsonIndex >= 0 ? args[jsonIndex + 1] : '';
const commandArgs = jsonIndex >= 0 ? args.slice(jsonIndex + 2) : [];

if (command === 'snapshot') {
  process.stdout.write(JSON.stringify({
    data: {
      snapshot: JSON.stringify(commandArgs),
      refs: { e1: {} },
      url: 'https://example.com'
    }
  }));
} else if (command === 'eval') {
  process.stdout.write(JSON.stringify({ data: [] }));
} else {
  process.stdout.write(JSON.stringify({ data: {} }));
}
`,
    'utf-8',
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function createAgentBrowserProfileEnvStub(
  root: string,
  envPath: string,
): string {
  const scriptPath = path.join(root, 'agent-browser-profile-env-stub.mjs');
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import fs from 'node:fs';

fs.writeFileSync(${JSON.stringify(
      envPath,
    )}, JSON.stringify({ profile: process.env.AGENT_BROWSER_PROFILE || null }));
process.stdout.write(JSON.stringify({
  data: {
    snapshot: '[]',
    refs: {},
    url: 'https://example.com'
  }
}));
`,
    'utf-8',
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function createAgentBrowserBrowserPathEnvStub(
  root: string,
  envPath: string,
): string {
  const scriptPath = path.join(root, 'agent-browser-playwright-env-stub.mjs');
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import fs from 'node:fs';

fs.writeFileSync(${JSON.stringify(
      envPath,
    )}, JSON.stringify({ playwright: process.env.PLAYWRIGHT_BROWSERS_PATH || null }));
process.stdout.write(JSON.stringify({
  data: {
    snapshot: '[]',
    refs: {},
    url: 'https://example.com'
  }
}));
`,
    'utf-8',
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function createAgentBrowserHeadedEnvStub(
  root: string,
  logPath: string,
): string {
  const scriptPath = path.join(root, 'agent-browser-headed-env-stub.mjs');
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
const jsonIndex = args.indexOf('--json');
const command = jsonIndex >= 0 ? args[jsonIndex + 1] : '';
const commandArgs = jsonIndex >= 0 ? args.slice(jsonIndex + 2) : [];
const record = {
  command,
  commandArgs,
  headed: process.env.AGENT_BROWSER_HEADED || null
};
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(record) + '\\n');

if (command === 'eval') {
  process.stdout.write(JSON.stringify({
    data: {
      text_length: 0,
      preview: '',
      preview_truncated: false,
      has_noscript: false,
      root_shell: false,
      ready_state: 'complete'
    }
  }));
} else if (command === 'open') {
  process.stdout.write(JSON.stringify({
    data: {
      url: commandArgs[0] || 'https://example.com/',
      title: 'Example'
    }
  }));
} else {
  process.stdout.write(JSON.stringify({ data: {} }));
}
`,
    'utf-8',
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  }
});

test.each([
  {
    label: 'interactive mode',
    args: { mode: 'interactive' },
    expectedArgs: ['-i', '-C'],
    expectedMode: 'interactive',
  },
  {
    label: 'interactive mode with full override',
    args: { mode: 'interactive', full: true },
    expectedArgs: ['-i', '-C'],
    expectedMode: 'interactive',
  },
  {
    label: 'full mode',
    args: { mode: 'full' },
    expectedArgs: ['-C'],
    expectedMode: 'full',
  },
  {
    label: 'default mode with full override',
    args: { full: true },
    expectedArgs: ['-C'],
    expectedMode: 'default',
  },
  {
    label: 'default compact mode',
    args: {},
    expectedArgs: ['-i', '-c', '-C'],
    expectedMode: 'default',
  },
])('browser_snapshot uses the expected cursor flags for $label', async ({
  args,
  expectedArgs,
  expectedMode,
}) => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-snapshot-'),
  );
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('AGENT_BROWSER_BIN', createAgentBrowserStub(tempRoot));

  const { executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  const output = await executeBrowserTool(
    'browser_snapshot',
    args,
    'session-1',
  );
  const parsed = JSON.parse(output) as {
    success: boolean;
    mode: string;
    snapshot: string;
  };

  expect(parsed.success).toBe(true);
  expect(parsed.mode).toBe(expectedMode);
  expect(JSON.parse(parsed.snapshot) as string[]).toEqual(expectedArgs);
});

test('browser_snapshot reuses the shared browser profile directly', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-shared-profile-'),
  );
  const sharedProfileDir = path.join(tempRoot, 'browser-profiles');
  const envPath = path.join(tempRoot, 'browser-env.json');
  fs.mkdirSync(sharedProfileDir, { recursive: true });
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('BROWSER_SHARED_PROFILE_DIR', sharedProfileDir);
  vi.stubEnv(
    'AGENT_BROWSER_BIN',
    createAgentBrowserProfileEnvStub(tempRoot, envPath),
  );

  const { executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  const output = await executeBrowserTool('browser_snapshot', {}, 'session-1');
  const parsed = JSON.parse(output) as { success: boolean };
  const envRecord = JSON.parse(fs.readFileSync(envPath, 'utf-8')) as {
    profile: string | null;
  };

  expect(parsed.success).toBe(true);
  expect(envRecord.profile).toBe(sharedProfileDir);
});

test('browser_snapshot prefers the host Playwright cache before the workspace cache', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-host-cache-'),
  );
  const homeDir = path.join(tempRoot, 'home');
  const hostCacheDir = path.join(homeDir, '.cache', 'ms-playwright');
  const envPath = path.join(tempRoot, 'browser-env.json');
  fs.mkdirSync(hostCacheDir, { recursive: true });
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv(
    'AGENT_BROWSER_BIN',
    createAgentBrowserBrowserPathEnvStub(tempRoot, envPath),
  );

  const { executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  const output = await executeBrowserTool('browser_snapshot', {}, 'session-1');
  const parsed = JSON.parse(output) as { success: boolean };
  const envRecord = JSON.parse(fs.readFileSync(envPath, 'utf-8')) as {
    playwright: string | null;
  };

  expect(parsed.success).toBe(true);
  expect(envRecord.playwright).toBe(hostCacheDir);
});

test('browser_navigate can request a headed browser session', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-headed-'),
  );
  const logPath = path.join(tempRoot, 'browser-env.jsonl');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv(
    'AGENT_BROWSER_BIN',
    createAgentBrowserHeadedEnvStub(tempRoot, logPath),
  );

  const { executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  const output = await executeBrowserTool(
    'browser_navigate',
    { url: 'https://example.com/', headed: true },
    'session-1',
  );
  const parsed = JSON.parse(output) as { success: boolean; headed: boolean };
  const records = fs
    .readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { command: string; headed: string });

  expect(parsed.success).toBe(true);
  expect(parsed.headed).toBe(true);
  expect(records.map((record) => record.command)).toEqual([
    'open',
    'eval',
    'network',
  ]);
  expect(records.every((record) => record.headed === '1')).toBe(true);
});

test('browser_navigate relaunches when headed mode changes', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-headed-switch-'),
  );
  const logPath = path.join(tempRoot, 'browser-env.jsonl');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv(
    'AGENT_BROWSER_BIN',
    createAgentBrowserHeadedEnvStub(tempRoot, logPath),
  );

  const { executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  await executeBrowserTool(
    'browser_navigate',
    { url: 'https://example.com/', headed: true },
    'session-1',
  );
  const output = await executeBrowserTool(
    'browser_navigate',
    { url: 'https://example.com/', headed: false },
    'session-1',
  );
  const parsed = JSON.parse(output) as { success: boolean; headed: boolean };
  const records = fs
    .readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { command: string; headed: string });

  expect(parsed.success).toBe(true);
  expect(parsed.headed).toBe(false);
  expect(records.map((record) => record.command)).toEqual([
    'open',
    'eval',
    'network',
    'close',
    'open',
    'eval',
    'network',
  ]);
  expect(records.slice(0, 4).every((record) => record.headed === '1')).toBe(
    true,
  );
  expect(records.slice(4).every((record) => record.headed === '0')).toBe(true);
});
