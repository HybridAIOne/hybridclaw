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
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const jsonIndex = args.indexOf('--json');
const command = jsonIndex >= 0 ? args[jsonIndex + 1] : '';
const commandArgs = jsonIndex >= 0 ? args.slice(jsonIndex + 2) : [];
if (process.env.AGENT_BROWSER_STUB_LOG) {
  fs.appendFileSync(
    process.env.AGENT_BROWSER_STUB_LOG,
    JSON.stringify({ command, args: commandArgs }) + '\\n',
  );
}

if (command === 'click') {
  process.stdout.write(JSON.stringify({
    data: {
      command,
      args: commandArgs
    }
  }));
} else if (command === 'download') {
  const targetPath = commandArgs[1] || '';
  if (targetPath) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, '%PDF test download');
  }
  process.stdout.write(JSON.stringify({
    data: {
      path: targetPath,
      filename: 'invoice.pdf',
      url: 'https://example.com/invoice.pdf'
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

function createInteractiveAgentBrowserStub(root: string): string {
  const scriptPath = path.join(
    root,
    'agent-browser-click-interactive-stub.mjs',
  );
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import vm from 'node:vm';

const args = process.argv.slice(2);
const jsonIndex = args.indexOf('--json');
const command = jsonIndex >= 0 ? args[jsonIndex + 1] : '';
const commandArgs = jsonIndex >= 0 ? args.slice(jsonIndex + 2) : [];

function createElement({
  tagName,
  text = '',
  attributes = {},
  cursor = 'auto',
  marker,
  state,
  parent = null,
  width = 120,
  height = 30,
}) {
  const element = {
    tagName: String(tagName || 'div').toUpperCase(),
    textContent: text,
    innerText: text,
    parentElement: parent,
    children: [],
    onclick: null,
    tabIndex: -1,
    __cursor: cursor,
    __attributes: attributes,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.__attributes, name)
        ? this.__attributes[name]
        : null;
    },
    getBoundingClientRect() {
      return { width, height };
    },
    scrollIntoView() {},
    click() {
      state.clickedMarker = marker;
    },
    dispatchEvent() {
      state.clickedMarker = marker;
      return true;
    },
  };
  if (parent) {
    parent.children.push(element);
  }
  return element;
}

function buildSandbox() {
  const state = { clickedMarker: null };
  const body = createElement({
    tagName: 'body',
    text: 'Library shelf entry Leben mit Bots with extra wrapper text',
    marker: 'body',
    state,
    width: 900,
    height: 700,
  });
  const wrapper = createElement({
    tagName: 'div',
    text: 'Shelf card for Leben mit Bots and metadata',
    marker: 'wrapper',
    state,
    parent: body,
    width: 700,
    height: 260,
  });
  const card = createElement({
    tagName: 'div',
    text: 'Leben mit Bots',
    cursor: 'pointer',
    marker: 'card',
    state,
    parent: wrapper,
    width: 260,
    height: 140,
  });
  const title = createElement({
    tagName: 'h3',
    text: 'Leben mit Bots',
    marker: 'title',
    state,
    parent: card,
    width: 180,
    height: 24,
  });
  const image = createElement({
    tagName: 'img',
    attributes: { alt: 'Cover: Leben mit Bots' },
    marker: 'image',
    state,
    parent: card,
    width: 80,
    height: 100,
  });

  const nodes = [body, wrapper, card, title, image];
  const document = {
    body,
    querySelector(selector) {
      if (selector === 'img[alt="Cover: Leben mit Bots"]') return image;
      return null;
    },
    createTreeWalker(root) {
      let index = 0;
      return {
        currentNode: root,
        nextNode() {
          index += 1;
          return nodes[index] || null;
        },
      };
    },
  };
  const window = {
    getComputedStyle(element) {
      return {
        display: 'block',
        visibility: 'visible',
        cursor: element.__cursor || 'auto',
      };
    },
  };

  const sandbox = {
    document,
    window,
    NodeFilter: { SHOW_ELEMENT: 1 },
    MouseEvent: class MouseEvent {
      constructor(type, init) {
        this.type = type;
        this.init = init;
      }
    },
  };
  window.window = window;
  return { sandbox, state };
}

if (command === 'click') {
  process.stdout.write(JSON.stringify({
    data: {
      command,
      args: commandArgs,
    },
  }));
} else if (command === 'eval') {
  const script = commandArgs[0] || '';
  const { sandbox, state } = buildSandbox();
  let result;
  try {
    result = vm.runInNewContext(script, sandbox);
  } catch (error) {
    process.stdout.write(JSON.stringify({
      data: {
        result: {
          ok: false,
          error: String(error && error.message ? error.message : error),
        },
      },
    }));
    process.exit(0);
  }
  if (result && result.ok === true && state.clickedMarker !== 'card') {
    result = {
      ok: false,
      error:
        'clicked non-actionable target ' +
        String(state.clickedMarker || 'none'),
    };
  }
  process.stdout.write(JSON.stringify({ data: { result } }));
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

test('browser_click prefers refs over text and coordinates when mixed targets are provided', async () => {
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
    {
      ref: 'e7',
      selector: 'img[alt="Cover: Leben mit Bots"]',
      text: 'Leben mit Bots',
      x: 1180,
      y: 650,
      exact: false,
    },
    'session-1',
  );
  const parsed = JSON.parse(output) as Record<string, unknown>;

  expect(parsed.success).toBe(true);
  expect(parsed.clicked).toBe('@e7');
  expect(parsed.ref).toBe('@e7');
  expect(parsed.text).toBeUndefined();
  expect(parsed.selector).toBeUndefined();
  expect(parsed.x).toBeUndefined();
});

test('browser_click prefers text over coordinates when no ref is provided', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-click-text-before-coordinate-'),
  );
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('AGENT_BROWSER_BIN', createAgentBrowserStub(tempRoot));

  const { executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  const output = await executeBrowserTool(
    'browser_click',
    {
      text: 'Leben mit Bots',
      x: 1180,
      y: 650,
      exact: true,
    },
    'session-1',
  );
  const parsed = JSON.parse(output) as Record<string, unknown>;

  expect(parsed.success).toBe(true);
  expect(parsed.clicked).toBe('Leben mit Bots');
  expect(parsed.text).toBe('Leben mit Bots');
  expect(parsed.exact).toBe(true);
  expect(parsed.x).toBeUndefined();
});

test('browser_click supports viewport coordinate clicks', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-click-coordinate-'),
  );
  const logPath = path.join(tempRoot, 'commands.jsonl');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('AGENT_BROWSER_BIN', createAgentBrowserStub(tempRoot));
  vi.stubEnv('AGENT_BROWSER_STUB_LOG', logPath);

  const { executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  const output = await executeBrowserTool(
    'browser_click',
    { x: 1180, y: 650 },
    'session-1',
  );
  const parsed = JSON.parse(output) as Record<string, unknown>;
  const commands = fs
    .readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(parsed.success, output).toBe(true);
  expect(parsed.clicked).toBe('1180,650');
  expect(parsed.x).toBe(1180);
  expect(parsed.y).toBe(650);
  expect(commands).toEqual([
    { command: 'mouse', args: ['move', '1180', '650'] },
    { command: 'mouse', args: ['down', 'left'] },
    { command: 'mouse', args: ['up', 'left'] },
  ]);
});

test('browser_click treats legacy @viewport refs as coordinate clicks', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-click-viewport-ref-'),
  );
  const logPath = path.join(tempRoot, 'commands.jsonl');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('AGENT_BROWSER_BIN', createAgentBrowserStub(tempRoot));
  vi.stubEnv('AGENT_BROWSER_STUB_LOG', logPath);

  const { executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  const output = await executeBrowserTool(
    'browser_click',
    { ref: '@viewport-1180-650' },
    'session-1',
  );
  const parsed = JSON.parse(output) as Record<string, unknown>;
  const commands = fs
    .readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  expect(parsed.success).toBe(true);
  expect(parsed.clicked).toBe('@viewport-1180-650');
  expect(parsed.x).toBe(1180);
  expect(parsed.y).toBe(650);
  expect(commands).toEqual([
    { command: 'mouse', args: ['move', '1180', '650'] },
    { command: 'mouse', args: ['down', 'left'] },
    { command: 'mouse', args: ['up', 'left'] },
  ]);
});

test('browser_click can download and save from a ref target', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-click-download-'),
  );
  const logPath = path.join(tempRoot, 'commands.jsonl');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('AGENT_BROWSER_BIN', createAgentBrowserStub(tempRoot));
  vi.stubEnv('AGENT_BROWSER_STUB_LOG', logPath);

  const { executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  const output = await executeBrowserTool(
    'browser_click',
    {
      ref: 'e25',
      waitForDownload: true,
      downloadPath: 'invoice-5563916179.pdf',
    },
    'session-1',
  );
  const parsed = JSON.parse(output) as Record<string, unknown>;
  const commands = fs
    .readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  expect(parsed.success, output).toBe(true);
  expect(parsed.clicked).toBe('@e25');
  expect(parsed.ref).toBe('@e25');
  expect(parsed.download_path).toBe(
    '.browser-artifacts/downloads/invoice-5563916179.pdf',
  );
  expect(parsed.suggested_filename).toBe('invoice.pdf');
  expect(parsed.download_url).toBe('https://example.com/invoice.pdf');
  expect(commands).toEqual([
    {
      command: 'download',
      args: [
        '@e25',
        path.join(
          tempRoot,
          '.browser-artifacts',
          'downloads',
          'invoice-5563916179.pdf',
        ),
      ],
    },
  ]);
});

test('browser_click rejects download capture for coordinate fallback clicks', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-click-coordinate-download-'),
  );
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('AGENT_BROWSER_BIN', createAgentBrowserStub(tempRoot));

  const { executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  const output = await executeBrowserTool(
    'browser_click',
    {
      x: 1183,
      y: 536,
      waitForDownload: true,
      downloadPath: 'invoice-5563916179.pdf',
    },
    'session-1',
  );
  const parsed = JSON.parse(output) as Record<string, unknown>;

  expect(parsed.success).toBe(false);
  expect(String(parsed.error)).toContain(
    'waitForDownload requires a snapshot ref or CSS selector target',
  );
});

test('browser_click selector fallback resolves to the clickable card ancestor', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-click-selector-runtime-'),
  );
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('AGENT_BROWSER_BIN', createInteractiveAgentBrowserStub(tempRoot));

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
  expect(parsed.selector).toBe(selector);
  expect(parsed.tag).toBe('div');
  expect(parsed.matched_text).toBe('Leben mit Bots');
});

test('browser_click text fallback prefers the specific text match over ancestor containers', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-click-text-runtime-'),
  );
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('AGENT_BROWSER_BIN', createInteractiveAgentBrowserStub(tempRoot));

  const { executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  const output = await executeBrowserTool(
    'browser_click',
    { text: 'Leben mit', exact: false },
    'session-1',
  );
  const parsed = JSON.parse(output) as Record<string, unknown>;

  expect(parsed.success).toBe(true);
  expect(parsed.text).toBe('Leben mit');
  expect(parsed.exact).toBe(false);
  expect(parsed.tag).toBe('div');
  expect(parsed.matched_text).toBe('Leben mit Bots');
  expect(parsed.matched_kind).toBe('text');
});
