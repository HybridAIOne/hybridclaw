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
  if (process.env.AGENT_BROWSER_STUB_NATIVE_DOWNLOAD_ON_TIMEOUT) {
    const downloadRoot = process.env.AGENT_BROWSER_DOWNLOAD_PATH || '';
    const nativePath = path.join(
      downloadRoot,
      'd13e9d4d-4daa-4b89-bc27-304ae66b9aa7',
    );
    fs.mkdirSync(path.dirname(nativePath), { recursive: true });
    fs.writeFileSync(nativePath, '%PDF native chrome download');
    process.stdout.write(JSON.stringify({
      success: false,
      error: 'Timeout waiting for download'
    }));
    process.exit(0);
  }
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
  const script = commandArgs[0] || '';
  if (
    script.includes('data-hybridclaw-frame-target') &&
    !script.includes('removeAttribute')
  ) {
    const result = process.env.AGENT_BROWSER_STUB_IFRAME_AT_POINT
      ? {
          ok: true,
          iframe: true,
          selector: '[data-hybridclaw-frame-target="frame-test"]',
          x: 150,
          y: 80,
          frame_left: 800,
          frame_top: 240
        }
      : { ok: true, iframe: false };
    process.stdout.write(JSON.stringify({ data: { result } }));
    process.exit(0);
  }
  if (script.includes('data-hybridclaw-download-target')) {
    process.stdout.write(JSON.stringify({
      data: {
        result: {
          ok: true,
          selector: '[data-hybridclaw-download-target="download-test"]',
          text: 'Herunterladen'
        }
      }
    }));
    process.exit(0);
  }
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

test('browser_click can resolve visible text and save a download', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-click-text-download-'),
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
      text: 'Herunterladen',
      exact: true,
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
  expect(parsed.clicked).toBe('Herunterladen');
  expect(parsed.text).toBe('Herunterladen');
  expect(parsed.download_path).toBe(
    '.browser-artifacts/downloads/invoice-5563916179.pdf',
  );
  expect(commands).toEqual([
    {
      command: 'eval',
      args: [expect.stringContaining('data-hybridclaw-download-target')],
    },
    {
      command: 'download',
      args: [
        '[data-hybridclaw-download-target="download-test"]',
        path.join(
          tempRoot,
          '.browser-artifacts',
          'downloads',
          'invoice-5563916179.pdf',
        ),
      ],
    },
    {
      command: 'eval',
      args: [expect.stringContaining('removeAttribute')],
    },
  ]);
});

test('browser_click can resolve coordinates and save a download', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-click-coordinate-download-'),
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
      x: 1183,
      y: 536,
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
  expect(parsed.clicked).toBe('1183,536');
  expect(parsed.x).toBe(1183);
  expect(parsed.y).toBe(536);
  expect(parsed.download_path).toBe(
    '.browser-artifacts/downloads/invoice-5563916179.pdf',
  );
  expect(commands).toEqual([
    {
      command: 'eval',
      args: [expect.stringContaining('data-hybridclaw-frame-target')],
    },
    {
      command: 'eval',
      args: [expect.stringContaining('data-hybridclaw-download-target')],
    },
    {
      command: 'download',
      args: [
        '[data-hybridclaw-download-target="download-test"]',
        path.join(
          tempRoot,
          '.browser-artifacts',
          'downloads',
          'invoice-5563916179.pdf',
        ),
      ],
    },
    {
      command: 'eval',
      args: [expect.stringContaining('removeAttribute')],
    },
  ]);
});

test('browser_click adopts native Chrome downloads when automation capture times out', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-click-native-download-'),
  );
  const logPath = path.join(tempRoot, 'commands.jsonl');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('AGENT_BROWSER_BIN', createAgentBrowserStub(tempRoot));
  vi.stubEnv('AGENT_BROWSER_STUB_LOG', logPath);
  vi.stubEnv('AGENT_BROWSER_STUB_NATIVE_DOWNLOAD_ON_TIMEOUT', '1');

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
  const savedPath = path.join(
    tempRoot,
    '.browser-artifacts',
    'downloads',
    'invoice-5563916179.pdf',
  );

  expect(parsed.success, output).toBe(true);
  expect(parsed.clicked).toBe('1183,536');
  expect(parsed.download_path).toBe(
    '.browser-artifacts/downloads/invoice-5563916179.pdf',
  );
  expect(parsed.download_observer).toBe('filesystem');
  expect(parsed.suggested_filename).toBe(
    'd13e9d4d-4daa-4b89-bc27-304ae66b9aa7',
  );
  expect(parsed.observed_download_path).toBe(
    '.browser-artifacts/downloads/d13e9d4d-4daa-4b89-bc27-304ae66b9aa7',
  );
  expect(fs.readFileSync(savedPath, 'utf-8')).toBe(
    '%PDF native chrome download',
  );
});

test('browser_downloads lists managed browser downloads newest first', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-downloads-'),
  );
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('AGENT_BROWSER_BIN', createAgentBrowserStub(tempRoot));

  const downloadRoot = path.join(tempRoot, '.browser-artifacts', 'downloads');
  fs.mkdirSync(downloadRoot, { recursive: true });
  const older = path.join(downloadRoot, 'older.pdf');
  const newer = path.join(downloadRoot, 'invoice-5563916179.pdf');
  fs.writeFileSync(older, '%PDF older');
  fs.writeFileSync(newer, '%PDF newer');
  const oldDate = new Date('2026-05-03T10:00:00Z');
  const newDate = new Date('2026-05-03T11:00:00Z');
  fs.utimesSync(older, oldDate, oldDate);
  fs.utimesSync(newer, newDate, newDate);

  const { executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  const output = await executeBrowserTool(
    'browser_downloads',
    { limit: 5 },
    'session-1',
  );
  const parsed = JSON.parse(output) as {
    success: boolean;
    count: number;
    downloads: Array<Record<string, unknown>>;
    root: string;
  };

  expect(parsed.success, output).toBe(true);
  expect(parsed.root).toBe('.browser-artifacts/downloads');
  expect(parsed.count).toBe(2);
  expect(parsed.downloads[0]?.path).toBe(
    '.browser-artifacts/downloads/invoice-5563916179.pdf',
  );
  expect(parsed.downloads[0]?.filename).toBe('invoice-5563916179.pdf');
  expect(parsed.downloads[1]?.path).toBe(
    '.browser-artifacts/downloads/older.pdf',
  );
});

test('browser_click can enter an iframe for coordinate download capture', async () => {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-click-iframe-download-'),
  );
  const logPath = path.join(tempRoot, 'commands.jsonl');
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', tempRoot);
  vi.stubEnv('AGENT_BROWSER_BIN', createAgentBrowserStub(tempRoot));
  vi.stubEnv('AGENT_BROWSER_STUB_LOG', logPath);
  vi.stubEnv('AGENT_BROWSER_STUB_IFRAME_AT_POINT', '1');

  const { executeBrowserTool } = await import(
    '../container/src/browser-tools.js'
  );

  const output = await executeBrowserTool(
    'browser_click',
    {
      x: 950,
      y: 320,
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
  expect(parsed.clicked).toBe('950,320');
  expect(parsed.x).toBe(950);
  expect(parsed.y).toBe(320);
  expect(parsed.frame_x).toBe(150);
  expect(parsed.frame_y).toBe(80);
  expect(parsed.download_path).toBe(
    '.browser-artifacts/downloads/invoice-5563916179.pdf',
  );
  expect(commands).toEqual([
    {
      command: 'eval',
      args: [expect.stringContaining('data-hybridclaw-frame-target')],
    },
    {
      command: 'frame',
      args: ['[data-hybridclaw-frame-target="frame-test"]'],
    },
    {
      command: 'eval',
      args: [expect.stringContaining('data-hybridclaw-download-target')],
    },
    {
      command: 'download',
      args: [
        '[data-hybridclaw-download-target="download-test"]',
        path.join(
          tempRoot,
          '.browser-artifacts',
          'downloads',
          'invoice-5563916179.pdf',
        ),
      ],
    },
    {
      command: 'eval',
      args: [expect.stringContaining('removeAttribute')],
    },
    {
      command: 'frame',
      args: ['main'],
    },
    {
      command: 'eval',
      args: [expect.stringContaining('data-hybridclaw-frame-target')],
    },
  ]);
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
