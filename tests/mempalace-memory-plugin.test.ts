import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

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

function installBundledPlugin(cwd: string): void {
  const sourceDir = path.join(process.cwd(), 'plugins', 'mempalace-memory');
  const targetDir = path.join(
    cwd,
    '.hybridclaw',
    'plugins',
    'mempalace-memory',
  );
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });
}

function writeMempalaceStub(rootDir: string): string {
  const scriptPath = path.join(rootDir, 'mock-mempalace.mjs');
  const commandLogPath = path.join(rootDir, 'mempalace-command-log.jsonl');
  fs.writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env node',
      'import fs from "node:fs";',
      'import path from "node:path";',
      `const commandLogPath = ${JSON.stringify(commandLogPath)};`,
      'const argv = process.argv.slice(2);',
      'function appendLog(entry) {',
      '  fs.appendFileSync(commandLogPath, JSON.stringify(entry) + "\\n", "utf8");',
      '}',
      'function listFiles(dirPath) {',
      '  const files = [];',
      '  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {',
      '    const fullPath = path.join(dirPath, entry.name);',
      '    if (entry.isDirectory()) {',
      '      files.push(...listFiles(fullPath));',
      '      continue;',
      '    }',
      '    files.push(fullPath);',
      '  }',
      '  return files;',
      '}',
      'let index = 0;',
      'let palacePath = "";',
      'while (index < argv.length && argv[index] === "--palace") {',
      '  palacePath = String(argv[index + 1] || "");',
      '  index += 2;',
      '}',
      'const command = String(argv[index] || "");',
      'const args = argv.slice(index + 1);',
      'if (command === "status") {',
      '  console.log("Palace ready at " + (palacePath || "~/.mempalace/palace"));',
      '  console.log("Wings: hybridclaw, docs");',
      '  process.exit(0);',
      '}',
      'if (command === "wake-up") {',
      '  const wingIndex = args.indexOf("--wing");',
      '  const wing = wingIndex >= 0 ? String(args[wingIndex + 1] || "") : "all";',
      '  console.log("Wake-up text (~140 tokens):");',
      '  console.log("==================================================");',
      '  console.log("TEAM: HybridClaw | ACTIVE_WING: " + wing);',
      '  console.log("DECISION: plugin.system->enabled | memory=external");',
      '  process.exit(0);',
      '}',
      'if (command === "search") {',
      '  const query = String(args[0] || "");',
      '  appendLog({ command, args, palacePath, files: [] });',
      '  console.log("============================================================");',
      '  console.log("  Results for: \\"" + query + "\\"");',
      '  console.log("============================================================");',
      '  console.log("");',
      '  console.log("  [1] hybridclaw / auth-migration");',
      '  console.log("      Source: auth.md");',
      '  console.log("      Match:  0.941");',
      '  console.log("");',
      '  console.log("      We switched auth because Clerk reduced integration time.");',
      '  process.exit(0);',
      '}',
      'if (command === "mine") {',
      '  const sourceDir = String(args[0] || "");',
      '  const files = fs.existsSync(sourceDir)',
      '    ? listFiles(sourceDir).map((filePath) => ({',
      '        path: filePath,',
      '        content: fs.readFileSync(filePath, "utf8"),',
      '      }))',
      '    : [];',
      '  appendLog({ command, args, palacePath, files });',
      '  console.log("Mined " + files.length + " transcript file(s)");',
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

function readMempalaceCommandLog(rootDir: string): Array<{
  command: string;
  args: string[];
  palacePath: string;
  files?: Array<{ path: string; content: string }>;
}> {
  const logPath = path.join(rootDir, 'mempalace-command-log.jsonl');
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
          palacePath: string;
          files?: Array<{ path: string; content: string }>;
        },
    );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
});

test('mempalace-memory injects wake-up and search context and exposes a command', async () => {
  const homeDir = makeTempDir('hybridclaw-mempalace-home-');
  const cwd = makeTempDir('hybridclaw-mempalace-project-');
  installBundledPlugin(cwd);
  const mempalaceCommand = writeMempalaceStub(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'mempalace-memory',
      enabled: true,
      config: {
        command: mempalaceCommand,
        palacePath: path.join(cwd, '.mempalace', 'palace'),
        wakeUpWing: 'hybridclaw',
        maxResults: 2,
        maxWakeUpChars: 500,
        maxSearchChars: 1200,
        maxInjectedChars: 2000,
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
        content: 'Why did we switch auth providers?',
        created_at: '2026-04-07T10:00:00.000Z',
      },
    ],
  });

  expect(promptContext).toHaveLength(1);
  expect(promptContext[0]).toContain('MemPalace wake-up context:');
  expect(promptContext[0]).toContain('TEAM: HybridClaw');
  expect(promptContext[0]).toContain(
    'MemPalace search results for the latest user question:',
  );
  expect(promptContext[0]).toContain('We switched auth because Clerk');

  const command = manager.findCommand('mempalace');
  expect(command).toBeDefined();
  await expect(
    command?.handler(['status'], {
      sessionId: 'session-1',
      channelId: 'web',
      userId: 'user-1',
    }),
  ).resolves.toContain(
    `Configured palace path: ${path.join(cwd, '.mempalace', 'palace')}`,
  );
  await expect(
    command?.handler(['status'], {
      sessionId: 'session-1',
      channelId: 'web',
      userId: 'user-1',
    }),
  ).resolves.toContain(
    'Configured MCP server: mempalace (not configured; plugin uses CLI recall)',
  );
});

test('mempalace-memory resolves ~ paths against the OS home directory', async () => {
  const cwd = makeTempDir('hybridclaw-mempalace-project-');
  const { resolveMempalacePluginConfig } = await import(
    '../plugins/mempalace-memory/src/config.js'
  );

  const resolved = resolveMempalacePluginConfig(
    {
      palacePath: '~/.mempalace/palace',
      workingDirectory: '~/src/example',
      sessionExportDir: '~/.hybridclaw/mempalace-turns',
      saveEveryMessages: 15,
      maxResults: 3,
      maxWakeUpChars: 1200,
      maxSearchChars: 2800,
      maxInjectedChars: 4000,
      timeoutMs: 12000,
    },
    {
      cwd,
      homeDir: path.join(os.homedir(), '.hybridclaw'),
      installRoot: '/tmp/install-root',
      runtimeConfigPath: '/tmp/config.json',
    },
  );

  expect(resolved.palacePath).toBe(
    path.join(os.homedir(), '.mempalace', 'palace'),
  );
  expect(resolved.workingDirectory).toBe(
    path.join(os.homedir(), 'src', 'example'),
  );
  expect(resolved.sessionExportDir).toBe(
    path.join(os.homedir(), '.hybridclaw', 'mempalace-turns'),
  );
});

test('mempalace-memory prefers MCP guidance when the mempalace MCP server is enabled', async () => {
  const homeDir = makeTempDir('hybridclaw-mempalace-home-');
  const cwd = makeTempDir('hybridclaw-mempalace-project-');
  installBundledPlugin(cwd);
  const mempalaceCommand = writeMempalaceStub(cwd);

  const config = loadRuntimeConfig();
  config.mcpServers = {
    mempalace: {
      transport: 'stdio',
      command: 'python3',
      args: ['-m', 'mempalace.mcp_server'],
      enabled: true,
    },
  };
  config.plugins.list = [
    {
      id: 'mempalace-memory',
      enabled: true,
      config: {
        command: mempalaceCommand,
        palacePath: path.join(cwd, '.mempalace', 'palace'),
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
    sessionId: 'session-mcp',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    recentMessages: [
      {
        id: 1,
        session_id: 'session-mcp',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'Why did we switch auth providers?',
        created_at: '2026-04-09T10:00:00.000Z',
      },
    ],
  });

  expect(promptContext).toHaveLength(1);
  expect(promptContext[0]).toContain(
    'MemPalace MCP tools are enabled for this session.',
  );
  expect(promptContext[0]).toContain('`mempalace__mempalace_status`');
  expect(promptContext[0]).toContain('`mempalace__mempalace_search`');
  expect(promptContext[0]).toContain('`mempalace__mempalace_kg_query`');
  expect(promptContext[0]).toContain('`mempalace__mempalace_get_taxonomy`');
  expect(promptContext[0]).not.toContain('MemPalace wake-up context:');
  expect(promptContext[0]).not.toContain(
    'MemPalace search results for the latest user question:',
  );

  const command = manager.findCommand('mempalace');
  await expect(
    command?.handler(['status'], {
      sessionId: 'session-mcp',
      channelId: 'web',
      userId: 'user-1',
    }),
  ).resolves.toContain(
    'Configured MCP server: mempalace (enabled; prompt recall uses MCP tools)',
  );
});

test('mempalace-memory picks up MCP server enablement without a plugin reload', async () => {
  const homeDir = makeTempDir('hybridclaw-mempalace-home-');
  const cwd = makeTempDir('hybridclaw-mempalace-project-');
  installBundledPlugin(cwd);
  const mempalaceCommand = writeMempalaceStub(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'mempalace-memory',
      enabled: true,
      config: {
        command: mempalaceCommand,
        palacePath: path.join(cwd, '.mempalace', 'palace'),
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

  const initialPromptContext = await manager.collectPromptContext({
    sessionId: 'session-live-mcp',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    recentMessages: [
      {
        id: 1,
        session_id: 'session-live-mcp',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'Why did we switch auth providers?',
        created_at: '2026-04-09T10:00:00.000Z',
      },
    ],
  });
  expect(initialPromptContext[0]).toContain('MemPalace wake-up context:');

  config.mcpServers = {
    mempalace: {
      transport: 'stdio',
      command: 'python3',
      args: ['-m', 'mempalace.mcp_server'],
      enabled: true,
    },
  };

  const mcpPromptContext = await manager.collectPromptContext({
    sessionId: 'session-live-mcp',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    recentMessages: [
      {
        id: 2,
        session_id: 'session-live-mcp',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'Show me the memory taxonomy.',
        created_at: '2026-04-09T10:01:00.000Z',
      },
    ],
  });
  expect(mcpPromptContext[0]).toContain(
    'MemPalace MCP tools are enabled for this session.',
  );
  expect(mcpPromptContext[0]).not.toContain('MemPalace wake-up context:');
});

test('mempalace-memory truncates long automatic search queries before invoking mempalace', async () => {
  const homeDir = makeTempDir('hybridclaw-mempalace-home-');
  const cwd = makeTempDir('hybridclaw-mempalace-project-');
  installBundledPlugin(cwd);
  const mempalaceCommand = writeMempalaceStub(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'mempalace-memory',
      enabled: true,
      config: {
        command: mempalaceCommand,
        searchEnabled: true,
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
  const longQuery = `Decision log:\n${'auth-migration '.repeat(120)}`.trim();
  await manager.collectPromptContext({
    sessionId: 'session-long-query',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    recentMessages: [
      {
        id: 1,
        session_id: 'session-long-query',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: longQuery,
        created_at: '2026-04-08T10:00:00.000Z',
      },
    ],
  });

  const searchEntry = readMempalaceCommandLog(cwd).find(
    (entry) => entry.command === 'search',
  );
  expect(searchEntry).toBeDefined();
  const query = searchEntry?.args[0] || '';
  expect(query.length).toBeLessThanOrEqual(800);
  expect(query).not.toContain('\n');
  expect(query.endsWith('…')).toBe(true);
});

test('mempalace-memory mines buffered turns on the agent-end autosave threshold', async () => {
  const homeDir = makeTempDir('hybridclaw-mempalace-home-');
  const cwd = makeTempDir('hybridclaw-mempalace-project-');
  installBundledPlugin(cwd);
  const mempalaceCommand = writeMempalaceStub(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'mempalace-memory',
      enabled: true,
      config: {
        command: mempalaceCommand,
        palacePath: path.join(cwd, '.mempalace', 'palace'),
        updateWing: 'hybridclaw',
        updateAgent: 'hybridclaw-bot',
        saveEveryMessages: 2,
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
  await expect(manager.getMemoryLayerBehavior()).resolves.toEqual({
    replacesBuiltInMemory: false,
  });

  await manager.notifyAgentEnd({
    sessionId: 'session/update-test',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    messages: [
      {
        id: 1,
        session_id: 'session/update-test',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'Why did we switch auth providers?',
        created_at: '2026-04-07T10:00:00.000Z',
      },
      {
        id: 2,
        session_id: 'session/update-test',
        user_id: 'assistant',
        username: null,
        role: 'assistant',
        content: 'We switched auth to reduce integration time.',
        created_at: '2026-04-07T10:00:10.000Z',
      },
    ],
    resultText: 'We switched auth to reduce integration time.',
    toolNames: [],
  });

  const commandLog = readMempalaceCommandLog(cwd);
  expect(commandLog).toHaveLength(1);
  expect(commandLog[0]).toMatchObject({
    command: 'mine',
    palacePath: path.join(cwd, '.mempalace', 'palace'),
    args: expect.arrayContaining([
      '--mode',
      'convos',
      '--wing',
      'hybridclaw',
      '--agent',
      'hybridclaw-bot',
    ]),
  });
  expect(commandLog[0]?.files).toHaveLength(1);
  expect(commandLog[0]?.files[0]?.content).toContain(
    '> Why did we switch auth providers?',
  );
  expect(commandLog[0]?.files[0]?.content).toContain(
    'We switched auth to reduce integration time.',
  );
});

test('mempalace-memory mirrors native memory writes immediately', async () => {
  const homeDir = makeTempDir('hybridclaw-mempalace-home-');
  const cwd = makeTempDir('hybridclaw-mempalace-project-');
  installBundledPlugin(cwd);
  const mempalaceCommand = writeMempalaceStub(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'mempalace-memory',
      enabled: true,
      config: {
        command: mempalaceCommand,
        palacePath: path.join(cwd, '.mempalace', 'palace'),
        updateWing: 'hybridclaw',
        updateAgent: 'hybridclaw-bot',
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
  await manager.notifyMemoryWrites({
    sessionId: 'session/native-memory-write',
    agentId: 'main',
    channelId: 'web',
    toolExecutions: [
      {
        name: 'memory',
        arguments:
          '{"action":"append","file_path":"memory/2026-04-08.md","content":"Remember Clerk reduced auth integration time."}',
        result: 'Appended 45 chars to memory/2026-04-08.md',
        durationMs: 10,
      },
    ],
  });

  const commandLog = readMempalaceCommandLog(cwd);
  expect(commandLog).toHaveLength(1);
  expect(commandLog[0]).toMatchObject({
    command: 'mine',
    palacePath: path.join(cwd, '.mempalace', 'palace'),
    args: expect.arrayContaining([
      '--mode',
      'convos',
      '--wing',
      'hybridclaw',
      '--agent',
      'hybridclaw-bot',
    ]),
  });
  expect(commandLog[0]?.files[0]?.content).toContain(
    'Mirror this explicit HybridClaw native memory write into MemPalace.',
  );
  expect(commandLog[0]?.files[0]?.content).toContain(
    'File: memory/2026-04-08.md',
  );
  expect(commandLog[0]?.files[0]?.content).toContain('Action: append');
  expect(commandLog[0]?.files[0]?.content).toContain(
    'Remember Clerk reduced auth integration time.',
  );
});

test('mempalace-memory flushes buffered turns before compaction', async () => {
  const homeDir = makeTempDir('hybridclaw-mempalace-home-');
  const cwd = makeTempDir('hybridclaw-mempalace-project-');
  installBundledPlugin(cwd);
  const mempalaceCommand = writeMempalaceStub(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'mempalace-memory',
      enabled: true,
      config: {
        command: mempalaceCommand,
        palacePath: path.join(cwd, '.mempalace', 'palace'),
        updateWing: 'hybridclaw',
        updateAgent: 'hybridclaw-bot',
        saveEveryMessages: 10,
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
  await manager.notifyAgentEnd({
    sessionId: 'session/compaction-test',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    messages: [
      {
        id: 1,
        session_id: 'session/compaction-test',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'Remember the auth migration reason.',
        created_at: '2026-04-07T10:00:00.000Z',
      },
      {
        id: 2,
        session_id: 'session/compaction-test',
        user_id: 'assistant',
        username: null,
        role: 'assistant',
        content: 'Clerk reduced auth integration time for the team.',
        created_at: '2026-04-07T10:00:10.000Z',
      },
    ],
    resultText: 'Clerk reduced auth integration time for the team.',
    toolNames: [],
  });

  expect(readMempalaceCommandLog(cwd)).toHaveLength(0);

  await manager.notifyBeforeCompaction({
    sessionId: 'session/compaction-test',
    agentId: 'main',
    channelId: 'web',
    summary: null,
    olderMessages: [],
  });

  const commandLog = readMempalaceCommandLog(cwd);
  expect(commandLog).toHaveLength(1);
  expect(commandLog[0]?.files[0]?.content).toContain(
    '> Remember the auth migration reason.',
  );
  expect(commandLog[0]?.files[0]?.content).toContain(
    'Clerk reduced auth integration time for the team.',
  );
});

test('mempalace-memory flushes pending autosave before manual search commands', async () => {
  const homeDir = makeTempDir('hybridclaw-mempalace-home-');
  const cwd = makeTempDir('hybridclaw-mempalace-project-');
  installBundledPlugin(cwd);
  const mempalaceCommand = writeMempalaceStub(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'mempalace-memory',
      enabled: true,
      config: {
        command: mempalaceCommand,
        palacePath: path.join(cwd, '.mempalace', 'palace'),
        updateWing: 'hybridclaw',
        updateAgent: 'hybridclaw-bot',
        saveEveryMessages: 10,
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
  await manager.notifyAgentEnd({
    sessionId: 'session/manual-search-flush',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    messages: [
      {
        id: 1,
        session_id: 'session/manual-search-flush',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'Remember the auth migration reason.',
        created_at: '2026-04-07T10:00:00.000Z',
      },
      {
        id: 2,
        session_id: 'session/manual-search-flush',
        user_id: 'assistant',
        username: null,
        role: 'assistant',
        content: 'Clerk reduced auth integration time for the team.',
        created_at: '2026-04-07T10:00:10.000Z',
      },
    ],
    resultText: 'Clerk reduced auth integration time for the team.',
    toolNames: [],
  });

  const command = manager.findCommand('mempalace');
  expect(command).toBeDefined();
  await expect(
    command?.handler(['search', '"auth', 'migration', 'reason"'], {
      sessionId: 'session/manual-search-flush',
      channelId: 'web',
      userId: 'user-1',
    }),
  ).resolves.toContain('Results for: "auth migration reason"');

  const commandLog = readMempalaceCommandLog(cwd);
  expect(commandLog).toHaveLength(2);
  expect(commandLog[0]?.command).toBe('mine');
  expect(commandLog[1]).toMatchObject({
    command: 'search',
    args: ['auth migration reason'],
    palacePath: path.join(cwd, '.mempalace', 'palace'),
  });
});
