import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

let tempRoot = '';

function createCleanupStub(root: string, logPath: string): string {
  const scriptPath = path.join(root, 'agent-browser-cleanup-stub.mjs');
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
const jsonIndex = args.indexOf('--json');
const command = jsonIndex >= 0 ? args[jsonIndex + 1] : '';
const commandArgs = jsonIndex >= 0 ? args.slice(jsonIndex + 2) : [];
const logPath = ${JSON.stringify(logPath)};
const entry = {
  command,
  commandArgs,
  socketDir: process.env.AGENT_BROWSER_SOCKET_DIR || null,
  sessionName: process.env.AGENT_BROWSER_SESSION_NAME || null,
};
fs.appendFileSync(logPath, JSON.stringify(entry) + '\\n');

if (command === 'snapshot') {
  process.stdout.write(JSON.stringify({
    data: {
      snapshot: '[]',
      refs: {},
      url: 'https://example.com'
    }
  }));
} else if (command === 'eval') {
  process.stdout.write(JSON.stringify({ data: [] }));
} else {
  process.stdout.write(JSON.stringify({ data: { closed: true } }));
}
`,
    'utf-8',
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function createCloseFailureStub(root: string, logPath: string): string {
  const scriptPath = path.join(root, 'agent-browser-close-failure-stub.mjs');
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const jsonIndex = args.indexOf('--json');
const command = jsonIndex >= 0 ? args[jsonIndex + 1] : '';
const logPath = ${JSON.stringify(logPath)};
const socketDir = process.env.AGENT_BROWSER_SOCKET_DIR || '';
fs.appendFileSync(
  logPath,
  JSON.stringify({ command, socketDir }) + '\\n',
);

if (command === 'snapshot') {
  fs.mkdirSync(socketDir, { recursive: true });
  fs.writeFileSync(path.join(socketDir, 'default.pid'), '4242');
  process.stdout.write(JSON.stringify({
    data: {
      snapshot: '[]',
      refs: {},
      url: 'https://example.com'
    }
  }));
} else if (command === 'eval') {
  process.stdout.write(JSON.stringify({ data: [] }));
} else if (command === 'close') {
  process.stdout.write(JSON.stringify({
    success: false,
    error: 'close failed'
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

test('cleanupAllBrowserSessions closes every tracked agent-browser session', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-cleanup-'),
  );
  const logPath = path.join(tempRoot, 'cleanup-log.jsonl');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('AGENT_BROWSER_BIN', createCleanupStub(tempRoot, logPath));

  const { cleanupAllBrowserSessions, executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  const first = JSON.parse(
    await executeBrowserTool('browser_snapshot', {}, 'session-a'),
  ) as { success: boolean };
  const second = JSON.parse(
    await executeBrowserTool('browser_snapshot', {}, 'session-b'),
  ) as { success: boolean };
  expect(first.success).toBe(true);
  expect(second.success).toBe(true);

  await cleanupAllBrowserSessions();

  const entries = fs
    .readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .map(
      (line) => JSON.parse(line) as { command: string; sessionName: string },
    );
  const closeSessions = entries
    .filter((entry) => entry.command === 'close')
    .map((entry) => entry.sessionName)
    .sort();

  expect(closeSessions).toHaveLength(2);
  expect(closeSessions[0]).toMatch(/^session-a_/);
  expect(closeSessions[1]).toMatch(/^session-b_/);
});

test('browser_close falls back to terminating the daemon process when close fails', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-close-fallback-'),
  );
  const logPath = path.join(tempRoot, 'close-log.jsonl');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('AGENT_BROWSER_BIN', createCloseFailureStub(tempRoot, logPath));

  let running = true;
  const killMock = vi
    .spyOn(process, 'kill')
    .mockImplementation((pid: number, signal?: number | NodeJS.Signals) => {
      expect(pid).toBe(4242);
      if (signal === 0 || signal == null) {
        if (!running) {
          const error = new Error('process not found') as Error & {
            code?: string;
          };
          error.code = 'ESRCH';
          throw error;
        }
        return true;
      }
      if (signal === 'SIGTERM') {
        running = false;
        return true;
      }
      return true;
    });

  const { executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  const snapshot = JSON.parse(
    await executeBrowserTool('browser_snapshot', {}, 'session-close'),
  ) as { success: boolean };
  expect(snapshot.success).toBe(true);

  const socketDir = fs
    .readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { command: string; socketDir: string })
    .find((entry) => entry.command === 'snapshot')?.socketDir;
  expect(socketDir).toBeTruthy();
  expect(fs.existsSync(path.join(socketDir || '', 'default.pid'))).toBe(true);

  const closed = JSON.parse(
    await executeBrowserTool('browser_close', {}, 'session-close'),
  ) as { success: boolean; closed: boolean; warning?: string };

  expect(closed.success).toBe(true);
  expect(closed.closed).toBe(true);
  expect(closed.warning).toBe('close failed');
  expect(killMock).toHaveBeenCalledWith(4242, 'SIGTERM');
  expect(killMock).not.toHaveBeenCalledWith(4242, 'SIGKILL');
  expect(fs.existsSync(socketDir || '')).toBe(false);
});
