import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

import type { RuntimeConfig } from '../src/config/runtime-config.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function loadRuntimeConfig(): RuntimeConfig {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as RuntimeConfig;
}

function installQmdPlugin(cwd: string): void {
  const sourceDir = path.join(process.cwd(), 'plugins', 'qmd-memory');
  const targetDir = path.join(cwd, '.hybridclaw', 'plugins', 'qmd-memory');
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });
}

function writeQmdStub(
  rootDir: string,
  options?: {
    searchPayload?: unknown;
    searchPayloadByQuery?: Record<string, unknown>;
    searchDelayMs?: number;
    statusText?: string;
    collectionAddText?: string;
    embedText?: string;
    embedDelayMs?: number;
  },
): string {
  const scriptPath = path.join(rootDir, 'mock-qmd.mjs');
  const searchPayload = options?.searchPayload || [
    {
      title: 'Architecture Notes',
      displayPath: 'notes/architecture.md',
      snippet:
        'Plugin commands are stored by the manager and need gateway dispatch.',
      context: 'Project docs',
      score: 0.93,
    },
    {
      title: 'Session Export Plan',
      displayPath: 'notes/session-export.md',
      snippet:
        'Export transcripts as markdown so QMD can index prior conversations.',
      score: 0.81,
    },
  ];
  const searchPayloadByQuery = options?.searchPayloadByQuery || {};
  const searchDelayMs = Number(options?.searchDelayMs || 0);
  const statusText =
    options?.statusText || 'Index ready\nCollections: notes, sessions';
  const collectionAddText = options?.collectionAddText || 'Collection added: .';
  const embedText = options?.embedText || 'Embedding completed.';
  const embedDelayMs = Number(options?.embedDelayMs || 0);
  fs.writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      'const command = args[0];',
      'const parseSearchQuery = (argv) => {',
      '  const flagOnlyArgs = new Set([',
      "    '--all', '--csv', '--explain', '--files', '--full', '--json',",
      "    '--line-numbers', '--md', '--xml'",
      '  ]);',
      '  const valueArgs = new Set([',
      "    '--candidate-limit', '--collection', '--index', '--min-score', '-C', '-c', '-n'",
      '  ]);',
      '  let afterDoubleDash = false;',
      '  for (let index = 0; index < argv.length; index += 1) {',
      '    const arg = argv[index];',
      '    if (afterDoubleDash) return String(arg || "");',
      '    if (arg === "--") {',
      '      afterDoubleDash = true;',
      '      continue;',
      '    }',
      '    if (flagOnlyArgs.has(arg)) continue;',
      '    if (valueArgs.has(arg)) {',
      '      index += 1;',
      '      continue;',
      '    }',
      '    return String(arg || "");',
      '  }',
      '  return "";',
      '};',
      'const query = parseSearchQuery(args.slice(1));',
      'const writeStdout = async (text) => {',
      '  await new Promise((resolve, reject) => {',
      '    process.stdout.write(`${String(text)}\\n`, (error) => {',
      '      if (error) reject(error);',
      '      else resolve();',
      '    });',
      '  });',
      '};',
      'const writeStderr = async (text) => {',
      '  await new Promise((resolve, reject) => {',
      '    process.stderr.write(`${String(text)}\\n`, (error) => {',
      '      if (error) reject(error);',
      '      else resolve();',
      '    });',
      '  });',
      '};',
      'if (command === "search" || command === "vsearch" || command === "query") {',
      `  const payloadByQuery = ${JSON.stringify(searchPayloadByQuery)};`,
      `  const defaultPayload = ${JSON.stringify(searchPayload)};`,
      '  const payload = Object.prototype.hasOwnProperty.call(payloadByQuery, query)',
      '    ? payloadByQuery[query]',
      '    : defaultPayload;',
      `  const delayMs = ${searchDelayMs};`,
      '  if (delayMs > 0) {',
      '    await new Promise((resolve) => setTimeout(resolve, delayMs));',
      '  }',
      '  await writeStdout(JSON.stringify(payload));',
      '  process.exit(0);',
      '}',
      'if (command === "status") {',
      `  await writeStdout(${JSON.stringify(statusText)});`,
      '  process.exit(0);',
      '}',
      'if (command === "collection" && args[1] === "add") {',
      `  await writeStdout(${JSON.stringify(collectionAddText)});`,
      '  process.exit(0);',
      '}',
      'if (command === "embed") {',
      `  const delayMs = ${embedDelayMs};`,
      '  if (delayMs > 0) {',
      '    await new Promise((resolve) => setTimeout(resolve, delayMs));',
      '  }',
      `  await writeStdout(${JSON.stringify(embedText)});`,
      '  process.exit(0);',
      '}',
      'await writeStderr(`unexpected command: ${command}`);',
      'process.exit(1);',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
});

test('QMD plugin injects external prompt context and exposes a status command', async () => {
  const homeDir = makeTempDir('hybridclaw-qmd-home-');
  const cwd = makeTempDir('hybridclaw-qmd-project-');
  installQmdPlugin(cwd);
  const qmdCommand = writeQmdStub(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'qmd-memory',
      enabled: true,
      config: {
        command: qmdCommand,
        maxResults: 2,
        maxSnippetChars: 120,
        maxInjectedChars: 600,
      },
    },
  ];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await manager.ensureInitialized();

  const promptContext = await manager.collectPromptContext({
    sessionId: 'session-1',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    recentMessages: [
      {
        id: 1,
        session_id: 'session-1',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'Where are the plugin command hooks documented?',
        created_at: '2026-03-19T10:00:00.000Z',
      },
    ],
  });

  expect(promptContext).toHaveLength(1);
  expect(promptContext[0]).toContain('External QMD knowledge search results:');
  expect(promptContext[0]).toContain(
    'These results come from an external indexed knowledge base',
  );
  expect(promptContext[0]).toContain('do not claim the source file is missing');
  expect(promptContext[0]).toContain('Architecture Notes');
  expect(promptContext[0]).toContain('notes/architecture.md');
  expect(promptContext[0]).toContain(
    'Plugin commands are stored by the manager',
  );

  const command = manager.findCommand('qmd');
  expect(command).toBeDefined();
  await expect(
    command?.handler(['status'], {
      sessionId: 'session-1',
      channelId: 'web',
      userId: 'user-1',
    }),
  ).resolves.toContain('Search mode: query');
  await expect(
    command?.handler(['status'], {
      sessionId: 'session-1',
      channelId: 'web',
      userId: 'user-1',
    }),
  ).resolves.toContain('Index ready');
  await expect(
    command?.handler(['collection', 'add', '.'], {
      sessionId: 'session-1',
      channelId: 'web',
      userId: 'user-1',
    }),
  ).resolves.toBe('Collection added: .');
});

test('QMD plugin retries prompt search with a condensed keyword query when the raw question misses', async () => {
  const homeDir = makeTempDir('hybridclaw-qmd-home-');
  const cwd = makeTempDir('hybridclaw-qmd-project-');
  installQmdPlugin(cwd);
  const qmdCommand = writeQmdStub(cwd, {
    searchPayloadByQuery: {
      'According to docs/content/extensibility/plugins.md, how are plugins discovered?':
        [],
      'content extensibility plugins discovered': [
        {
          title: 'Plugin System',
          file: 'qmd://hybridclaw/docs/content/extensibility/plugins.md',
          snippet:
            'HybridClaw plugins are local runtime extensions discovered from plugin directories.',
          score: 0.89,
        },
      ],
    },
  });

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'qmd-memory',
      enabled: true,
      config: {
        command: qmdCommand,
      },
    },
  ];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await manager.ensureInitialized();

  const promptContext = await manager.collectPromptContext({
    sessionId: 'session-keywords',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    recentMessages: [
      {
        id: 1,
        session_id: 'session-keywords',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content:
          'According to docs/content/extensibility/plugins.md, how are plugins discovered?',
        created_at: '2026-03-19T10:00:00.000Z',
      },
    ],
  });

  expect(promptContext).toHaveLength(1);
  expect(promptContext[0]).toContain(
    'User question: According to docs/content/extensibility/plugins.md, how are plugins discovered?',
  );
  expect(promptContext[0]).toContain(
    'QMD search query: content extensibility plugins discovered',
  );
  expect(promptContext[0]).toContain('Plugin System');
  expect(promptContext[0]).toContain('docs/content/extensibility/plugins.md');
});

test('QMD plugin terminates options before a leading-dash search query', async () => {
  const homeDir = makeTempDir('hybridclaw-qmd-home-');
  const cwd = makeTempDir('hybridclaw-qmd-project-');
  installQmdPlugin(cwd);
  const qmdCommand = writeQmdStub(cwd, {
    searchPayloadByQuery: {
      '--help': [
        {
          title: 'Dash Query',
          file: 'qmd://hybridclaw/docs/dash-query.md',
          snippet: 'Leading-dash queries should be treated as data, not flags.',
          score: 0.91,
        },
      ],
    },
  });

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'qmd-memory',
      enabled: true,
      config: {
        command: qmdCommand,
      },
    },
  ];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await manager.ensureInitialized();

  const promptContext = await manager.collectPromptContext({
    sessionId: 'session-leading-dash-query',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    recentMessages: [
      {
        id: 1,
        session_id: 'session-leading-dash-query',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: '--help',
        created_at: '2026-03-20T09:00:00.000Z',
      },
    ],
  });

  expect(promptContext).toHaveLength(1);
  expect(promptContext[0]).toContain('User question: --help');
  expect(promptContext[0]).toContain('Dash Query');
  expect(promptContext[0]).toContain(
    'Leading-dash queries should be treated as data, not flags.',
  );
});

test('QMD plugin uses the latest user message even when recentMessages are reverse-ordered', async () => {
  const homeDir = makeTempDir('hybridclaw-qmd-home-');
  const cwd = makeTempDir('hybridclaw-qmd-project-');
  installQmdPlugin(cwd);
  const qmdCommand = writeQmdStub(cwd, {
    searchPayloadByQuery: {
      'older question': [],
      'latest question': [
        {
          title: 'Latest Hit',
          file: 'qmd://hybridclaw/docs/content/extensibility/plugins.md',
          snippet: 'Latest user question won.',
          score: 0.9,
        },
      ],
    },
  });

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'qmd-memory',
      enabled: true,
      config: {
        command: qmdCommand,
      },
    },
  ];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await manager.ensureInitialized();

  const promptContext = await manager.collectPromptContext({
    sessionId: 'session-latest-message',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    recentMessages: [
      {
        id: 22,
        session_id: 'session-latest-message',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'latest question',
        created_at: '2026-03-19T10:01:00.000Z',
      },
      {
        id: 21,
        session_id: 'session-latest-message',
        user_id: 'user-1',
        username: 'alice',
        role: 'assistant',
        content: 'previous answer',
        created_at: '2026-03-19T10:00:30.000Z',
      },
      {
        id: 20,
        session_id: 'session-latest-message',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'older question',
        created_at: '2026-03-19T10:00:00.000Z',
      },
    ],
  });

  expect(promptContext).toHaveLength(1);
  expect(promptContext[0]).toContain('User question: latest question');
  expect(promptContext[0]).toContain('Latest Hit');
  expect(promptContext[0]).toContain('Latest user question won.');
});

test('runQmd caps captured stdout for verbose commands', async () => {
  const cwd = makeTempDir('hybridclaw-qmd-project-');
  const qmdCommand = writeQmdStub(cwd, {
    statusText: 'A'.repeat(80_000),
  });

  const { runQmd } = await import('../plugins/qmd-memory/src/qmd-process.js');
  const result = await runQmd(['status'], {
    command: qmdCommand,
    workingDirectory: cwd,
    timeoutMs: 1000,
    maxInjectedChars: 500,
  });

  expect(result.ok).toBe(true);
  expect(result.stdoutTruncated).toBe(true);
  expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(32_768);
});

test('runQmd sends SIGTERM before SIGKILL when a timed-out child does not exit', async () => {
  const cwd = makeTempDir('hybridclaw-qmd-project-');
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn((signal: string) => {
    if (signal === 'SIGKILL') {
      setTimeout(() => {
        child.emit('close', null, 'SIGKILL');
      }, 0);
    }
    return true;
  });

  vi.useFakeTimers();
  vi.doMock('node:child_process', () => ({
    spawn: vi.fn(() => child),
  }));

  try {
    const { runQmd } = await import('../plugins/qmd-memory/src/qmd-process.js');
    const resultPromise = runQmd(['status'], {
      command: 'qmd',
      workingDirectory: cwd,
      timeoutMs: 100,
      maxInjectedChars: 500,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');

    await vi.advanceTimersByTimeAsync(250);
    await vi.runAllTimersAsync();
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain('QMD timed out after 100ms.');
  } finally {
    vi.useRealTimers();
    vi.doUnmock('node:child_process');
  }
});

test('runQmd passes a reduced environment to the QMD child process', async () => {
  const cwd = makeTempDir('hybridclaw-qmd-project-');
  const scriptPath = path.join(cwd, 'mock-qmd-env.mjs');
  fs.writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env node',
      'const payload = {',
      '  path: process.env.PATH || null,',
      '  home: process.env.HOME || process.env.USERPROFILE || null,',
      '  tmpdir: process.env.TMPDIR || process.env.TMP || process.env.TEMP || null,',
      '  secret: process.env.HYBRIDCLAW_QMD_SECRET_TEST || null,',
      '};',
      'await new Promise((resolve, reject) => {',
      '  process.stdout.write(`${JSON.stringify(payload)}\\n`, (error) => {',
      '    if (error) reject(error);',
      '    else resolve();',
      '  });',
      '});',
      'process.exit(0);',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.chmodSync(scriptPath, 0o755);

  const previousSecret = process.env.HYBRIDCLAW_QMD_SECRET_TEST;
  process.env.HYBRIDCLAW_QMD_SECRET_TEST = 'super-secret';

  try {
    const { runQmd } = await import('../plugins/qmd-memory/src/qmd-process.js');
    const result = await runQmd(['status'], {
      command: scriptPath,
      workingDirectory: cwd,
      timeoutMs: 1000,
      maxInjectedChars: 500,
    });

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.path).toBeTypeOf('string');
    expect(parsed.home).toBeTypeOf('string');
    expect(parsed.secret).toBeNull();
  } finally {
    if (previousSecret === undefined) {
      delete process.env.HYBRIDCLAW_QMD_SECRET_TEST;
    } else {
      process.env.HYBRIDCLAW_QMD_SECRET_TEST = previousSecret;
    }
  }
});

test('QMD prompt search fails cleanly when search output exceeds the capture limit', async () => {
  const cwd = makeTempDir('hybridclaw-qmd-project-');
  const qmdCommand = writeQmdStub(cwd, {
    searchPayload: Array.from({ length: 300 }, (_, index) => ({
      title: `Hit ${index}`,
      file: `qmd://hybridclaw/docs/${index}.md`,
      snippet: 'Verbose snippet '.repeat(20),
      score: 0.5,
    })),
  });

  const { buildQmdPromptContextResult } = await import(
    '../plugins/qmd-memory/src/qmd-process.js'
  );

  await expect(
    buildQmdPromptContextResult({
      config: {
        command: qmdCommand,
        workingDirectory: cwd,
        searchMode: 'search',
        maxResults: 10,
        maxSnippetChars: 600,
        maxInjectedChars: 500,
        timeoutMs: 1000,
      },
      recentMessages: [
        {
          id: 1,
          session_id: 'session-truncated-search',
          user_id: 'user-1',
          username: 'alice',
          role: 'user',
          content: 'plugin',
          created_at: '2026-03-19T10:00:00.000Z',
        },
      ],
    }),
  ).rejects.toThrow('QMD search output exceeded the capture limit.');
});

test('QMD plugin warns during startup when the QMD status probe fails', async () => {
  const homeDir = makeTempDir('hybridclaw-qmd-home-');
  const cwd = makeTempDir('hybridclaw-qmd-project-');
  const debug = vi.fn();
  const warn = vi.fn();
  const info = vi.fn();
  const memoryLayers: Array<{
    start?: () => Promise<void>;
    getContextForPrompt?: (params: {
      recentMessages: unknown[];
    }) => Promise<string | null>;
  }> = [];

  const plugin = (await import('../plugins/qmd-memory/src/index.js')).default;
  plugin.register({
    pluginId: 'qmd-memory',
    pluginDir: path.join(cwd, '.hybridclaw', 'plugins', 'qmd-memory'),
    registrationMode: 'full',
    config: loadRuntimeConfig(),
    pluginConfig: {
      command: path.join(cwd, 'missing-qmd'),
      maxResults: 10,
      maxSnippetChars: 600,
      maxInjectedChars: 4000,
      timeoutMs: 12_000,
    },
    logger: { debug, warn, info },
    runtime: {
      cwd,
      homeDir,
      installRoot: process.cwd(),
      runtimeConfigPath: path.join(homeDir, '.hybridclaw', 'config.json'),
    },
    registerMemoryLayer(layer) {
      memoryLayers.push(layer);
    },
    registerProvider() {},
    registerChannel() {},
    registerTool() {},
    registerPromptHook() {},
    registerCommand() {},
    registerService() {},
    on() {},
    resolvePath(relative) {
      return path.resolve(cwd, relative);
    },
    getCredential() {
      return undefined;
    },
  });

  const layer = memoryLayers[0];
  if (!layer?.start) {
    throw new Error('Expected qmd-memory layer to register a start hook');
  }

  await layer.start();

  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      command: path.join(cwd, 'missing-qmd'),
      workingDirectory: cwd,
    }),
    'QMD startup health-check failed',
  );
});

test('QMD plugin returns no extra context when the qmd command is unavailable', async () => {
  const homeDir = makeTempDir('hybridclaw-qmd-home-');
  const cwd = makeTempDir('hybridclaw-qmd-project-');
  installQmdPlugin(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'qmd-memory',
      enabled: true,
      config: {
        command: path.join(cwd, 'missing-qmd'),
      },
    },
  ];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await manager.ensureInitialized();

  const promptContext = await manager.collectPromptContext({
    sessionId: 'session-2',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    recentMessages: [
      {
        id: 1,
        session_id: 'session-2',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'What do the architecture notes say?',
        created_at: '2026-03-19T11:00:00.000Z',
      },
    ],
  });

  expect(promptContext).toEqual([]);
});

test('QMD plugin exports session transcripts as markdown when enabled', async () => {
  const homeDir = makeTempDir('hybridclaw-qmd-home-');
  const cwd = makeTempDir('hybridclaw-qmd-project-');
  installQmdPlugin(cwd);
  const qmdCommand = writeQmdStub(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'qmd-memory',
      enabled: true,
      config: {
        command: qmdCommand,
        sessionExport: true,
      },
    },
  ];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await manager.ensureInitialized();
  await manager.notifyTurnComplete({
    sessionId: 'session/export-test',
    userId: 'user-1',
    agentId: 'main',
    messages: [
      {
        id: 1,
        session_id: 'session/export-test',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'Need QMD coverage.',
        created_at: '2026-03-19T12:00:00.000Z',
      },
      {
        id: 2,
        session_id: 'session/export-test',
        user_id: 'user-1',
        username: null,
        role: 'assistant',
        content: 'Implemented session transcript export.',
        created_at: '2026-03-19T12:00:10.000Z',
      },
    ],
  });

  const exportDir = path.join(cwd, '.hybridclaw', 'qmd-sessions');
  const exportPath = path.join(exportDir, 'session-export-test.md');
  expect(fs.existsSync(exportPath)).toBe(true);

  const exported = fs.readFileSync(exportPath, 'utf-8');
  const frontmatterMatch = exported.match(/^---\n([\s\S]*?)\n---/);
  expect(frontmatterMatch?.[1]).toBeTruthy();
  expect(parseYaml(frontmatterMatch?.[1] || '')).toMatchObject({
    sessionId: 'session/export-test',
    userId: 'user-1',
    agentId: 'main',
    messageCount: 2,
  });
  expect(exported).toContain('# HybridClaw Session session/export-test');
  expect(exported).toContain('Need QMD coverage.');
  expect(exported).toContain('Implemented session transcript export.');
});

test('QMD session export frontmatter uses YAML-safe string quoting', async () => {
  const { buildSessionExportMarkdown } = await import(
    '../plugins/qmd-memory/src/session-export.js'
  );
  const markdown = buildSessionExportMarkdown({
    sessionId: 'sess:\n"\u2028"',
    userId: 'user-\u0007',
    agentId: 'main-\u{1F419}',
    messages: [],
  });

  const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---/);
  expect(frontmatterMatch?.[1]).toBeTruthy();
  const parsed = parseYaml(frontmatterMatch?.[1] || '');

  expect(parsed).toMatchObject({
    sessionId: 'sess:\n"\u2028"',
    userId: 'user-\u0007',
    agentId: 'main-\u{1F419}',
    messageCount: 0,
  });
});

test('QMD session export uses distinct hashed fallback filenames for path-unsafe session ids', async () => {
  const cwd = makeTempDir('hybridclaw-qmd-project-');
  const exportDir = path.join(cwd, '.hybridclaw', 'qmd-sessions');
  const { writeSessionExport } = await import(
    '../plugins/qmd-memory/src/session-export.js'
  );

  const firstPath = await writeSessionExport({
    exportDir,
    sessionId: '!!!',
    userId: 'user-1',
    agentId: 'main',
    messages: [],
  });
  const secondPath = await writeSessionExport({
    exportDir,
    sessionId: '???',
    userId: 'user-1',
    agentId: 'main',
    messages: [],
  });

  expect(path.basename(firstPath)).not.toBe('session.md');
  expect(path.basename(secondPath)).not.toBe('session.md');
  expect(path.basename(firstPath)).not.toBe(path.basename(secondPath));
  expect(path.basename(firstPath)).toMatch(/^session-[a-f0-9]{12}\.md$/);
  expect(path.basename(secondPath)).toMatch(/^session-[a-f0-9]{12}\.md$/);
  expect(fs.existsSync(firstPath)).toBe(true);
  expect(fs.existsSync(secondPath)).toBe(true);
});

test('QMD plugin always includes the first result even when the prompt budget is tight', async () => {
  const homeDir = makeTempDir('hybridclaw-qmd-home-');
  const cwd = makeTempDir('hybridclaw-qmd-project-');
  installQmdPlugin(cwd);
  const qmdCommand = writeQmdStub(cwd, {
    searchPayload: [
      {
        title: 'Architecture Notes',
        displayPath: 'notes/architecture.md',
        snippet:
          'Plugin commands are stored by the manager and need gateway dispatch. '.repeat(
            20,
          ),
        context: 'Project docs',
        score: 0.93,
      },
      {
        title: 'Should Not Fit',
        displayPath: 'notes/overflow.md',
        snippet: 'This result should be omitted by the injected prompt budget.',
        score: 0.25,
      },
    ],
  });

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'qmd-memory',
      enabled: true,
      config: {
        command: qmdCommand,
        maxResults: 2,
        maxSnippetChars: 500,
        maxInjectedChars: 500,
      },
    },
  ];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await manager.ensureInitialized();

  const promptContext = await manager.collectPromptContext({
    sessionId: 'session-tight-budget',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    recentMessages: [
      {
        id: 1,
        session_id: 'session-tight-budget',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'plugin',
        created_at: '2026-03-19T13:00:00.000Z',
      },
    ],
  });

  expect(promptContext).toHaveLength(1);
  expect(promptContext[0].length).toBeLessThanOrEqual(500);
  expect(promptContext[0]).toContain('Architecture Notes');
  expect(promptContext[0]).not.toContain('Should Not Fit');
});

test('QMD passthrough commands are not cut off by the short prompt-search timeout', async () => {
  const homeDir = makeTempDir('hybridclaw-qmd-home-');
  const cwd = makeTempDir('hybridclaw-qmd-project-');
  installQmdPlugin(cwd);
  const qmdCommand = writeQmdStub(cwd, {
    embedDelayMs: 1050,
    embedText: 'Embeddings updated.',
  });

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'qmd-memory',
      enabled: true,
      config: {
        command: qmdCommand,
        timeoutMs: 1000,
      },
    },
  ];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await manager.ensureInitialized();

  const command = manager.findCommand('qmd');
  await expect(
    Promise.resolve(
      command?.handler(['embed'], {
        sessionId: 'session-embed',
        channelId: 'web',
        userId: 'user-1',
      }),
    ),
  ).resolves.toBe('Embeddings updated.');
});

test('runQmdCommandText uses a larger but finite timeout for passthrough commands', async () => {
  const cwd = makeTempDir('hybridclaw-qmd-project-');
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn((signal: string) => {
    if (signal === 'SIGKILL') {
      setTimeout(() => {
        child.emit('close', null, 'SIGKILL');
      }, 0);
    }
    return true;
  });

  vi.useFakeTimers();
  vi.doMock('node:child_process', () => ({
    spawn: vi.fn(() => child),
  }));

  try {
    const { runQmdCommandText } = await import(
      '../plugins/qmd-memory/src/qmd-process.js'
    );
    const resultPromise = runQmdCommandText(['embed'], {
      command: 'qmd',
      workingDirectory: cwd,
      timeoutMs: 1_000,
      maxInjectedChars: 500,
    });
    const rejection = expect(resultPromise).rejects.toThrow(
      'QMD timed out after 900000ms.',
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(840_000);
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');

    await vi.advanceTimersByTimeAsync(250);
    await vi.runAllTimersAsync();
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');

    await rejection;
  } finally {
    vi.useRealTimers();
    vi.doUnmock('node:child_process');
  }
});

test('QMD plugin emits debug logs describing injected prompt context', async () => {
  const homeDir = makeTempDir('hybridclaw-qmd-home-');
  const cwd = makeTempDir('hybridclaw-qmd-project-');
  const qmdCommand = writeQmdStub(cwd, {
    searchPayloadByQuery: {
      'According to docs/content/extensibility/plugins.md, how are plugins discovered?':
        [],
      'content extensibility plugins discovered': [
        {
          title: 'Plugin System',
          file: 'qmd://hybridclaw/docs/content/extensibility/plugins.md',
          snippet:
            'HybridClaw plugins are local runtime extensions discovered from plugin directories.',
          score: 0.89,
        },
      ],
    },
  });

  const debug = vi.fn();
  const warn = vi.fn();
  const info = vi.fn();
  const memoryLayers: Array<{
    getContextForPrompt?: (params: {
      recentMessages: unknown[];
    }) => Promise<string | null>;
  }> = [];

  const plugin = (await import('../plugins/qmd-memory/src/index.js')).default;
  plugin.register({
    pluginId: 'qmd-memory',
    pluginDir: path.join(cwd, '.hybridclaw', 'plugins', 'qmd-memory'),
    registrationMode: 'full',
    config: loadRuntimeConfig(),
    pluginConfig: {
      command: qmdCommand,
      maxResults: 10,
      maxSnippetChars: 600,
      maxInjectedChars: 4000,
      timeoutMs: 12_000,
    },
    logger: { debug, warn, info },
    runtime: {
      cwd,
      homeDir,
      installRoot: process.cwd(),
      runtimeConfigPath: path.join(homeDir, '.hybridclaw', 'config.json'),
    },
    registerMemoryLayer(layer) {
      memoryLayers.push(layer);
    },
    registerProvider() {},
    registerChannel() {},
    registerTool() {},
    registerPromptHook() {},
    registerCommand() {},
    registerService() {},
    on() {},
    resolvePath(relative) {
      return path.resolve(cwd, relative);
    },
    getCredential() {
      return undefined;
    },
  });

  const layer = memoryLayers[0];
  if (!layer?.getContextForPrompt) {
    throw new Error(
      'Expected qmd-memory layer to register getContextForPrompt',
    );
  }

  const promptContext = await layer.getContextForPrompt({
    recentMessages: [
      {
        id: 1,
        session_id: 'session-debug-log',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content:
          'According to docs/content/extensibility/plugins.md, how are plugins discovered?',
        created_at: '2026-03-19T10:00:00.000Z',
      },
    ],
  });

  expect(promptContext).toContain('Plugin System');
  expect(debug).toHaveBeenCalledWith(
    expect.objectContaining({
      resultCount: 1,
      usedFallbackQuery: true,
      topResultPaths: ['qmd://hybridclaw/docs/content/extensibility/plugins.md'],
    }),
    'QMD prompt context injected',
  );
  expect(warn).not.toHaveBeenCalled();
});

test('QMD plugin treats prompt search timeouts as a quiet no-context fallback', async () => {
  const homeDir = makeTempDir('hybridclaw-qmd-home-');
  const cwd = makeTempDir('hybridclaw-qmd-project-');
  const qmdCommand = writeQmdStub(cwd, {
    searchDelayMs: 150,
  });

  const debug = vi.fn();
  const warn = vi.fn();
  const info = vi.fn();
  const memoryLayers = [];

  const plugin = (await import('../plugins/qmd-memory/src/index.js')).default;
  plugin.register({
    pluginId: 'qmd-memory',
    pluginDir: path.join(cwd, '.hybridclaw', 'plugins', 'qmd-memory'),
    registrationMode: 'full',
    config: loadRuntimeConfig(),
    pluginConfig: {
      command: qmdCommand,
      maxResults: 10,
      maxSnippetChars: 600,
      maxInjectedChars: 4000,
      timeoutMs: 100,
    },
    logger: { debug, warn, info },
    runtime: {
      cwd,
      homeDir,
      installRoot: process.cwd(),
      runtimeConfigPath: path.join(homeDir, '.hybridclaw', 'config.json'),
    },
    registerMemoryLayer(layer) {
      memoryLayers.push(layer);
    },
    registerProvider() {},
    registerChannel() {},
    registerTool() {},
    registerPromptHook() {},
    registerCommand() {},
    registerService() {},
    on() {},
    resolvePath(relative) {
      return path.resolve(cwd, relative);
    },
    getCredential() {
      return undefined;
    },
  });

  const layer = memoryLayers[0];
  if (!layer?.getContextForPrompt) {
    throw new Error(
      'Expected qmd-memory layer to register getContextForPrompt',
    );
  }

  const promptContext = await layer.getContextForPrompt({
    recentMessages: [
      {
        id: 1,
        session_id: 'session-timeout',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'Where are the plugin command hooks documented?',
        created_at: '2026-03-19T10:00:00.000Z',
      },
    ],
  });

  expect(promptContext).toBeNull();
  expect(debug).toHaveBeenCalledWith(
    expect.objectContaining({
      searchMode: 'query',
      timeoutMs: 100,
      workingDirectory: cwd,
    }),
    'QMD prompt search timed out; skipping context injection',
  );
  expect(warn).not.toHaveBeenCalled();
});
