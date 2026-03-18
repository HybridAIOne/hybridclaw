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
])(
  'browser_snapshot uses the expected cursor flags for $label',
  async ({ args, expectedArgs, expectedMode }) => {
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
  },
);
