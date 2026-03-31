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
