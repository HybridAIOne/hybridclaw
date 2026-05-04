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
if (process.env.AGENT_BROWSER_STUB_LOG) {
  const fs = await import('node:fs');
  fs.appendFileSync(
    process.env.AGENT_BROWSER_STUB_LOG,
    JSON.stringify({ command, args: commandArgs }) + '\\n',
  );
}

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
  headed: process.env.AGENT_BROWSER_HEADED || null,
  executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH || null,
  browserArgs: process.env.AGENT_BROWSER_ARGS || null
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

function createAgentBrowserScreenshotStub(root: string, logPath: string): string {
  const scriptPath = path.join(root, 'agent-browser-screenshot-stub.mjs');
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const jsonIndex = args.indexOf('--json');
const command = jsonIndex >= 0 ? args[jsonIndex + 1] : '';
const commandArgs = jsonIndex >= 0 ? args.slice(jsonIndex + 2) : [];
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({ command, commandArgs }));
if (command === 'screenshot') {
  fs.mkdirSync(path.dirname(commandArgs.at(-1)), { recursive: true });
  fs.writeFileSync(commandArgs.at(-1), 'png');
}
process.stdout.write(JSON.stringify({ data: {} }));
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

test('browser_snapshot can target an iframe before collecting refs', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-snapshot-frame-'),
  );
  const logPath = path.join(tempRoot, 'commands.jsonl');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('AGENT_BROWSER_BIN', createAgentBrowserStub(tempRoot));
  vi.stubEnv('AGENT_BROWSER_STUB_LOG', logPath);

  const { executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  const output = await executeBrowserTool(
    'browser_snapshot',
    { mode: 'full', frame: 'iframe#payments' },
    'session-1',
  );
  const parsed = JSON.parse(output) as {
    success: boolean;
    frame: string;
  };
  const commands = fs
    .readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  expect(parsed.success).toBe(true);
  expect(parsed.frame).toBe('iframe#payments');
  expect(commands[0]).toEqual({
    command: 'frame',
    args: ['iframe#payments'],
  });
  expect(commands[1]).toEqual({ command: 'snapshot', args: ['-C'] });
});

test('browser_screenshot returns a vision-ready artifact path', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-screenshot-'),
  );
  const logPath = path.join(tempRoot, 'screenshot-command.json');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv(
    'AGENT_BROWSER_BIN',
    createAgentBrowserScreenshotStub(tempRoot, logPath),
  );

  const { executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  const output = await executeBrowserTool(
    'browser_screenshot',
    { path: 'documents-page-visible.png' },
    'session-1',
  );
  const parsed = JSON.parse(output) as {
    success: boolean;
    path: string;
    image_url: string;
  };
  const command = JSON.parse(fs.readFileSync(logPath, 'utf-8')) as {
    command: string;
    commandArgs: string[];
  };

  expect(parsed.success).toBe(true);
  expect(parsed.path).toBe('.browser-artifacts/documents-page-visible.png');
  expect(parsed.image_url).toBe(
    '.browser-artifacts/documents-page-visible.png',
  );
  expect(command.command).toBe('screenshot');
  expect(command.commandArgs.at(-1)).toBe(
    path.join(tempRoot, '.browser-artifacts', 'documents-page-visible.png'),
  );
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
  const chromeBin = path.join(tempRoot, 'Google Chrome');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('CHROME_BIN', chromeBin);
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
    .map(
      (line) =>
        JSON.parse(line) as {
          command: string;
          headed: string;
          executablePath: string | null;
          browserArgs: string | null;
        },
    );

  expect(parsed.success).toBe(true);
  expect(parsed.headed).toBe(true);
  expect(records.map((record) => record.command)).toEqual([
    'open',
    'eval',
    'network',
  ]);
  expect(records.every((record) => record.headed === '1')).toBe(true);
  expect(records.every((record) => record.executablePath === chromeBin)).toBe(
    true,
  );
  expect(records[0]?.browserArgs?.split('\n')).toEqual(
    expect.arrayContaining([
      '--no-first-run',
      '--no-default-browser-check',
      '--password-store=basic',
      '--use-mock-keychain',
    ]),
  );
});

test('browser_navigate relaunches when headed mode changes', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-headed-switch-'),
  );
  const logPath = path.join(tempRoot, 'browser-env.jsonl');
  vi.stubEnv('CHROME_BIN', path.join(tempRoot, 'Google Chrome'));
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

test('browser_navigate preserves configured browser args in headed mode', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-headed-args-'),
  );
  const logPath = path.join(tempRoot, 'browser-env.jsonl');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('CHROME_BIN', path.join(tempRoot, 'Google Chrome'));
  vi.stubEnv('AGENT_BROWSER_ARGS', '--start-maximized');
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
    .map(
      (line) =>
        JSON.parse(line) as {
          command: string;
          browserArgs: string | null;
        },
    );

  expect(parsed.success).toBe(true);
  expect(parsed.headed).toBe(true);
  expect(records[0]?.browserArgs?.split('\n')).toEqual(
    expect.arrayContaining([
      '--start-maximized',
      '--no-first-run',
      '--password-store=basic',
    ]),
  );
});

test('browser_navigate refuses headed mode without a system browser', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-headed-no-system-'),
  );
  const logPath = path.join(tempRoot, 'browser-env.jsonl');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('AGENT_BROWSER_EXECUTABLE_PATH', '');
  vi.stubEnv('BROWSER_CDP_URL', '');
  vi.stubEnv('CHROME_BIN', '');
  vi.stubEnv('PATH', path.dirname(process.execPath));
  vi.stubEnv(
    'AGENT_BROWSER_BIN',
    createAgentBrowserHeadedEnvStub(tempRoot, logPath),
  );
  const originalExistsSync = fs.existsSync;
  vi.spyOn(fs, 'existsSync').mockImplementation((target) => {
    const normalized = String(target);
    if (
      normalized ===
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    ) {
      return false;
    }
    return originalExistsSync(target);
  });

  const { executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  const output = await executeBrowserTool(
    'browser_navigate',
    { url: 'https://example.com/', headed: true },
    'session-1',
  );
  const parsed = JSON.parse(output) as { success: boolean; error: string };

  expect(parsed.success).toBe(false);
  expect(parsed.error).toContain(
    'Headful browser control requires Google Chrome',
  );
  expect(fs.existsSync(logPath)).toBe(false);
});
