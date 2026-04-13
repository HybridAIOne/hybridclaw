import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

let tempRoot = '';

function createAgentBrowserNavigateStub(root: string, logPath: string): string {
  const scriptPath = path.join(root, 'agent-browser-navigate-stub.mjs');
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
  JSON.stringify({ command, commandArgs, rawArgs: args }) + '\\n',
);

if (command === 'open') {
  process.stdout.write(JSON.stringify({
    data: {
      url: commandArgs[commandArgs.length - 1] || 'https://example.com',
      title: 'Example',
    },
  }));
} else if (command === 'eval') {
  process.stdout.write(JSON.stringify({
    data: {
      result: {
        text_length: 0,
        preview: '',
        preview_truncated: false,
        has_noscript: false,
        root_shell: false,
        ready_state: 'complete',
      },
    },
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

async function importBrowserToolsWithProvider(
  browserUseProvider: Record<string, unknown>,
) {
  vi.resetModules();
  vi.doMock('../container/src/browser-use-provider.js', () => ({
    browserUseProvider,
  }));
  return await import('../container/src/browser-tools.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../container/src/browser-use-provider.js');
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  }
});

test('browser_navigate keeps the local browser path by default when Browser Use is configured', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-navigate-local-'),
  );
  const logPath = path.join(tempRoot, 'navigate-log.jsonl');
  const ensureCdpSession = vi.fn();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv(
    'AGENT_BROWSER_BIN',
    createAgentBrowserNavigateStub(tempRoot, logPath),
  );

  const { executeBrowserTool } = await importBrowserToolsWithProvider({
    isEnabled: () => true,
    shouldUseCloudCdp: () => false,
    ensureCdpSession,
    closeLocalSession: async () => ({ warnings: [], artifacts: [] }),
    getTrackedSessionIds: () => [],
    getLatestRecordingArtifacts: () => [],
  });

  const output = await executeBrowserTool(
    'browser_navigate',
    { url: 'https://example.com' },
    'session-1',
  );
  const parsed = JSON.parse(output) as {
    success: boolean;
    execution_strategy: string;
  };
  const commands = fs
    .readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          command: string;
          commandArgs: string[];
          rawArgs: string[];
        },
    );
  const openCommand = commands.find((entry) => entry.command === 'open');

  expect(parsed.success).toBe(true);
  expect(parsed.execution_strategy).toBe('local-cdp');
  expect(ensureCdpSession).not.toHaveBeenCalled();
  expect(openCommand?.commandArgs).not.toContain('--cdp');
});

test('browser_navigate uses cloud CDP only when the Browser Use session explicitly opts in', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-navigate-cloud-'),
  );
  const logPath = path.join(tempRoot, 'navigate-log.jsonl');
  const ensureCdpSession = vi.fn(async () => ({
    id: 'browser-123',
    cdpUrl: 'wss://browser-use.example/cdp/browser-123',
    liveUrl: 'https://browser-use.example/live/browser-123',
    enableRecording: false,
  }));
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv(
    'AGENT_BROWSER_BIN',
    createAgentBrowserNavigateStub(tempRoot, logPath),
  );

  const { executeBrowserTool } = await importBrowserToolsWithProvider({
    isEnabled: () => true,
    shouldUseCloudCdp: () => true,
    ensureCdpSession,
    closeLocalSession: async () => ({ warnings: [], artifacts: [] }),
    getTrackedSessionIds: () => [],
    getLatestRecordingArtifacts: () => [],
  });

  const output = await executeBrowserTool(
    'browser_navigate',
    { url: 'https://example.com' },
    'session-1',
  );
  const parsed = JSON.parse(output) as {
    success: boolean;
    execution_strategy: string;
    cloud_session_id?: string;
  };
  const commands = fs
    .readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          command: string;
          commandArgs: string[];
          rawArgs: string[];
        },
    );
  const openCommand = commands.find((entry) => entry.command === 'open');

  expect(parsed.success).toBe(true);
  expect(parsed.execution_strategy).toBe('cloud-cdp');
  expect(parsed.cloud_session_id).toBe('browser-123');
  expect(ensureCdpSession).toHaveBeenCalledWith({
    localSessionId: 'session-1',
    proxyCountry: undefined,
    timeoutMinutes: undefined,
  });
  expect(openCommand?.rawArgs).toContain('--cdp');
  expect(openCommand?.rawArgs).toContain(
    'wss://browser-use.example/cdp/browser-123',
  );
});
