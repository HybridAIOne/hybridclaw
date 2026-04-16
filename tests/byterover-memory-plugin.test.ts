import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type { RuntimeConfig } from '../src/config/runtime-config.js';

const tempDirs: string[] = [];
const originalBrvApiKey = process.env.BRV_API_KEY;

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

function installBundledPlugin(cwd: string): void {
  const sourceDir = path.join(process.cwd(), 'plugins', 'byterover-memory');
  const targetDir = path.join(
    cwd,
    '.hybridclaw',
    'plugins',
    'byterover-memory',
  );
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });
}

function writeByteRoverStub(rootDir: string): string {
  const scriptPath = path.join(rootDir, 'mock-brv.mjs');
  const commandLogPath = path.join(rootDir, 'byterover-command-log.jsonl');
  fs.writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env node',
      'import fs from "node:fs";',
      `const commandLogPath = ${JSON.stringify(commandLogPath)};`,
      'const argv = process.argv.slice(2);',
      'const command = String(argv[0] || "");',
      'const args = argv.slice(1);',
      'fs.appendFileSync(commandLogPath, JSON.stringify({',
      '  command,',
      '  args,',
      '  cwd: process.cwd(),',
      '  apiKey: process.env.BRV_API_KEY || "",',
      '}) + "\\n", "utf8");',
      'if (command === "status") {',
      '  console.log("ByteRover ready");',
      '  console.log("Tree nodes: 42");',
      '  process.exit(0);',
      '}',
      'if (command === "query") {',
      '  const queryIndex = args.indexOf("--");',
      '  const query = queryIndex >= 0 ? args.slice(queryIndex + 1).join(" ") : args.join(" ");',
      '  if (query.toLowerCase().includes("unknown")) {',
      '    console.log("No relevant memories found.");',
      '    process.exit(0);',
      '  }',
      '  console.log("Decision: Clerk reduced auth integration time.");',
      '  console.log("Preference: concise answers are preferred.");',
      '  process.exit(0);',
      '}',
      'if (command === "curate") {',
      '  console.log("Curated into ByteRover tree.");',
      '  process.exit(0);',
      '}',
      'console.error("unexpected command: " + command);',
      'process.exit(1);',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function readByteRoverCommandLog(rootDir: string): Array<{
  command: string;
  args: string[];
  cwd: string;
  apiKey: string;
}> {
  const logPath = path.join(rootDir, 'byterover-command-log.jsonl');
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          command: string;
          args: string[];
          cwd: string;
          apiKey: string;
        },
    );
}

function decodeCommandPayload(args: string[]): string {
  const markerIndex = args.indexOf('--');
  if (markerIndex < 0) return args.join(' ');
  return args.slice(markerIndex + 1).join(' ');
}

afterEach(() => {
  if (typeof originalBrvApiKey === 'string') {
    process.env.BRV_API_KEY = originalBrvApiKey;
  } else {
    delete process.env.BRV_API_KEY;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

test('resolveByteRoverPluginConfig resolves defaults and ~ paths', async () => {
  const cwd = makeTempDir('hybridclaw-byterover-project-');
  const runtimeHome = makeTempDir('hybridclaw-byterover-home-');
  const { resolveByteRoverPluginConfig } = await import(
    '../plugins/byterover-memory/src/config.js'
  );

  const resolved = resolveByteRoverPluginConfig(
    {
      command: 'custom-brv',
      workingDirectory: '~/byterover-sandbox',
      autoCurate: false,
      maxInjectedChars: 1200,
      queryTimeoutMs: 15000,
      curateTimeoutMs: 180000,
    },
    {
      cwd,
      homeDir: runtimeHome,
      installRoot: '/tmp/install-root',
      runtimeConfigPath: '/tmp/config.json',
    },
  );

  expect(resolved.command).toBe('custom-brv');
  expect(resolved.workingDirectory).toBe(
    path.join(os.homedir(), 'byterover-sandbox'),
  );
  expect(resolved.autoCurate).toBe(false);
  expect(resolved.mirrorMemoryWrites).toBe(true);
  expect(resolved.maxInjectedChars).toBe(1200);
  expect(resolved.queryTimeoutMs).toBe(15000);
  expect(resolved.curateTimeoutMs).toBe(180000);

  const defaults = resolveByteRoverPluginConfig(
    {},
    {
      cwd,
      homeDir: runtimeHome,
      installRoot: '/tmp/install-root',
      runtimeConfigPath: '/tmp/config.json',
    },
  );
  expect(defaults.command).toBe('brv');
  expect(defaults.workingDirectory).toBe(path.join(runtimeHome, 'byterover'));
  expect(defaults.autoCurate).toBe(true);
  expect(defaults.mirrorMemoryWrites).toBe(true);
});

test('byterover-memory injects recall context, exposes tools and command, and curates HybridClaw events', async () => {
  process.env.BRV_API_KEY = 'test-brv-key';

  const homeDir = makeTempDir('hybridclaw-byterover-home-');
  const cwd = makeTempDir('hybridclaw-byterover-project-');
  installBundledPlugin(cwd);
  const byteroverCommand = writeByteRoverStub(cwd);
  const workingDirectory = path.join(homeDir, 'byterover-store');
  const resolvedWorkingDirectory = path.join(
    fs.realpathSync(path.dirname(workingDirectory)),
    'byterover-store',
  );

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'byterover-memory',
      enabled: true,
      config: {
        command: byteroverCommand,
        workingDirectory,
        maxInjectedChars: 900,
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

  expect(manager.getLoadedPlugins()).toEqual([
    expect.objectContaining({
      id: 'byterover-memory',
      enabled: true,
      status: 'loaded',
    }),
  ]);
  expect(manager.getToolDefinitions()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'brv_curate' }),
      expect.objectContaining({ name: 'brv_query' }),
      expect.objectContaining({ name: 'brv_status' }),
    ]),
  );

  const promptContext = await manager.collectPromptContext({
    sessionId: 'session-1',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    workspacePath: cwd,
    recentMessages: [
      {
        id: 1,
        session_id: 'session-1',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content:
          'Why did we switch auth providers, and what response style do I prefer?',
        created_at: '2026-04-10T10:00:00.000Z',
      },
    ],
  });

  expect(promptContext.join('\n\n')).toContain(
    'ByteRover memory tools are enabled.',
  );
  expect(promptContext.join('\n\n')).toContain(
    'ByteRover recalled context for the latest user message:',
  );
  expect(promptContext.join('\n\n')).toContain(
    'Clerk reduced auth integration time.',
  );

  await expect(
    manager.executeTool({
      toolName: 'brv_status',
      args: {},
      sessionId: 'session-1',
      channelId: 'web',
    }),
  ).resolves.toContain(`Working directory: ${workingDirectory}`);

  await expect(
    manager.executeTool({
      toolName: 'brv_query',
      args: { query: 'auth provider decision' },
      sessionId: 'session-1',
      channelId: 'web',
    }),
  ).resolves.toContain('Preference: concise answers are preferred.');

  await expect(
    manager.executeTool({
      toolName: 'brv_curate',
      args: { content: 'Remember the repo uses Biome formatting.' },
      sessionId: 'session-1',
      channelId: 'web',
    }),
  ).resolves.toBe('ByteRover memory updated.');

  const command = manager.findCommand('byterover');
  expect(command).toBeDefined();
  await expect(
    Promise.resolve(
      command?.handler(['status'], {
        sessionId: 'session-1',
        channelId: 'web',
        userId: 'user-1',
      }),
    ),
  ).resolves.toContain(`Command: ${byteroverCommand}`);

  await manager.notifyTurnComplete({
    sessionId: 'session-1',
    userId: 'user-1',
    agentId: 'main',
    workspacePath: cwd,
    messages: [
      {
        id: 2,
        session_id: 'session-1',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'Remember zebra lantern 42 for the release checklist.',
        created_at: '2026-04-10T10:01:00.000Z',
      },
      {
        id: 3,
        session_id: 'session-1',
        user_id: 'assistant',
        username: null,
        role: 'assistant',
        content: 'I will keep that in mind for the release checklist.',
        created_at: '2026-04-10T10:01:05.000Z',
      },
    ],
  });

  await manager.notifyMemoryWrites({
    sessionId: 'session-1',
    agentId: 'main',
    channelId: 'web',
    toolExecutions: [
      {
        name: 'memory',
        arguments:
          '{"action":"append","target":"user","content":"Prefers concise answers."}',
        result: 'Appended 25 chars to USER.md',
        durationMs: 8,
      },
    ],
  });

  await manager.notifyBeforeCompaction({
    sessionId: 'session-1',
    agentId: 'main',
    channelId: 'web',
    summary: 'Auth migration decisions and tone preferences.',
    olderMessages: [
      {
        id: 4,
        session_id: 'session-1',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'Clerk reduced the auth integration time significantly.',
        created_at: '2026-04-10T09:00:00.000Z',
      },
      {
        id: 5,
        session_id: 'session-1',
        user_id: 'assistant',
        username: null,
        role: 'assistant',
        content: 'We should preserve that decision and keep responses concise.',
        created_at: '2026-04-10T09:00:10.000Z',
      },
    ],
  });

  await manager.shutdown();

  const commandLog = readByteRoverCommandLog(cwd);
  expect(commandLog).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        command: 'status',
        cwd: resolvedWorkingDirectory,
        apiKey: 'test-brv-key',
      }),
      expect.objectContaining({
        command: 'query',
        cwd: resolvedWorkingDirectory,
        apiKey: 'test-brv-key',
      }),
      expect.objectContaining({
        command: 'curate',
        cwd: resolvedWorkingDirectory,
        apiKey: 'test-brv-key',
      }),
    ]),
  );

  const curatePayloads = commandLog
    .filter((entry) => entry.command === 'curate')
    .map((entry) => decodeCommandPayload(entry.args));
  expect(
    curatePayloads.some((payload) =>
      payload.includes('Remember the repo uses Biome formatting.'),
    ),
  ).toBe(true);
  expect(
    curatePayloads.some((payload) =>
      payload.includes(
        'User: Remember zebra lantern 42 for the release checklist.',
      ),
    ),
  ).toBe(true);
  expect(
    curatePayloads.some((payload) =>
      payload.includes('[User profile]\nPrefers concise answers.'),
    ),
  ).toBe(true);
  expect(
    curatePayloads.some((payload) =>
      payload.includes('[Pre-compaction context]'),
    ),
  ).toBe(true);
});
