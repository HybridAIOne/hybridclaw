import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

let tempRoot = '';

function createAgentBrowserStub(root: string): string {
  const scriptPath = path.join(root, 'agent-browser-click-stub.mjs');
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const jsonIndex = args.indexOf('--json');
const command = jsonIndex >= 0 ? args[jsonIndex + 1] : '';
const commandArgs = jsonIndex >= 0 ? args.slice(jsonIndex + 2) : [];

if (command === 'click') {
  process.stdout.write(JSON.stringify({
    data: {
      command,
      args: commandArgs
    }
  }));
} else if (command === 'eval') {
  process.stdout.write(JSON.stringify({
    data: {
      result: {
        ok: true,
        tag: 'h3',
        text: 'Leben mit Bots',
        matched_kind: 'text'
      }
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

test('browser_click preserves ref-based clicks', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-click-ref-'),
  );
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('AGENT_BROWSER_BIN', createAgentBrowserStub(tempRoot));

  const { executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  const output = await executeBrowserTool(
    'browser_click',
    { ref: 'e7' },
    'session-1',
  );
  const parsed = JSON.parse(output) as Record<string, unknown>;

  expect(parsed.success).toBe(true);
  expect(parsed.clicked).toBe('@e7');
  expect(parsed.ref).toBe('@e7');
  expect(parsed.tag).toBeUndefined();
});

test('browser_click accepts selector fallback clicks', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-click-selector-'),
  );
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('AGENT_BROWSER_BIN', createAgentBrowserStub(tempRoot));

  const { executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  const selector = 'img[alt="Cover: Leben mit Bots"]';
  const output = await executeBrowserTool(
    'browser_click',
    { selector },
    'session-1',
  );
  const parsed = JSON.parse(output) as Record<string, unknown>;

  expect(parsed.success).toBe(true);
  expect(parsed.clicked).toBe(selector);
  expect(parsed.selector).toBe(selector);
  expect(parsed.tag).toBe('h3');
  expect(parsed.matched_text).toBe('Leben mit Bots');
});

test('browser_click accepts visible-text fallback clicks', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-click-text-'),
  );
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('AGENT_BROWSER_BIN', createAgentBrowserStub(tempRoot));

  const { executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  const output = await executeBrowserTool(
    'browser_click',
    { text: 'Leben mit Bots', exact: true },
    'session-1',
  );
  const parsed = JSON.parse(output) as Record<string, unknown>;

  expect(parsed.success).toBe(true);
  expect(parsed.clicked).toBe('Leben mit Bots');
  expect(parsed.text).toBe('Leben mit Bots');
  expect(parsed.exact).toBe(true);
  expect(parsed.tag).toBe('h3');
  expect(parsed.matched_text).toBe('Leben mit Bots');
  expect(parsed.matched_kind).toBe('text');
});

test('browser_click rejects ambiguous targeting inputs', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-click-ambiguous-'),
  );
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('AGENT_BROWSER_BIN', createAgentBrowserStub(tempRoot));

  const { executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  const output = await executeBrowserTool(
    'browser_click',
    { ref: 'e7', text: 'Leben mit Bots' },
    'session-1',
  );
  const parsed = JSON.parse(output) as Record<string, unknown>;

  expect(parsed.success).toBe(false);
  expect(parsed.error).toBe(
    'browser_click accepts only one of ref, selector, or text',
  );
});
