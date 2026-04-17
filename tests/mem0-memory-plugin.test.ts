import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type { RuntimeConfig } from '../src/config/runtime-config.js';

const tempDirs: string[] = [];
const originalMem0ApiKey = process.env.MEM0_API_KEY;
const originalMem0Telemetry = process.env.MEM0_TELEMETRY;

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

function installBundledPlugin(cwd: string): string {
  const sourceDir = path.join(process.cwd(), 'plugins', 'mem0-memory');
  const targetDir = path.join(cwd, '.hybridclaw', 'plugins', 'mem0-memory');
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });
  return targetDir;
}

function installMem0Stub(
  pluginDir: string,
  responses: Record<string, unknown>,
) {
  const nodeModuleDir = path.join(pluginDir, 'node_modules', 'mem0ai');
  const logPath = path.join(pluginDir, 'mem0-stub-log.jsonl');
  const responsePath = path.join(pluginDir, 'mem0-stub-responses.json');
  fs.mkdirSync(nodeModuleDir, { recursive: true });
  fs.writeFileSync(
    path.join(nodeModuleDir, 'package.json'),
    JSON.stringify(
      {
        name: 'mem0ai',
        version: '0.0.0-test',
        type: 'module',
        exports: {
          '.': './index.js',
        },
      },
      null,
      2,
    ),
    'utf-8',
  );
  fs.writeFileSync(responsePath, JSON.stringify(responses, null, 2), 'utf-8');
  fs.writeFileSync(
    path.join(nodeModuleDir, 'index.js'),
    [
      'import fs from "node:fs";',
      `const logPath = ${JSON.stringify(logPath)};`,
      `const responsePath = ${JSON.stringify(responsePath)};`,
      'function append(entry) {',
      '  fs.appendFileSync(logPath, JSON.stringify(entry) + "\\n", "utf8");',
      '}',
      'function readResponses() {',
      '  return JSON.parse(fs.readFileSync(responsePath, "utf8"));',
      '}',
      'export class MemoryClient {',
      '  constructor(options) {',
      '    this.options = options;',
      '    this.client = { defaults: {} };',
      '    append({ method: "constructor", options });',
      '  }',
      '  async ping() {',
      '    append({ method: "ping" });',
      '    return { status: "ok", org_id: "org-test", project_id: "proj-test" };',
      '  }',
      '  async getAll(options = {}) {',
      '    append({ method: "getAll", options });',
      '    return readResponses().getAll ?? [];',
      '  }',
      '  async search(query, options = {}) {',
      '    append({ method: "search", query, options });',
      '    return readResponses().search ?? [];',
      '  }',
      '  async add(messages, options = {}) {',
      '    append({ method: "add", messages, options });',
      '    return readResponses().add ?? [];',
      '  }',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );
  return logPath;
}

function readStubLog(logPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.resetModules();
  process.env.MEM0_API_KEY = originalMem0ApiKey;
  process.env.MEM0_TELEMETRY = originalMem0Telemetry;
});

test('resolveMem0PluginConfig only accepts MEM0_API_KEY from credentials', async () => {
  const { resolveMem0PluginConfig } = await import(
    '../plugins/mem0-memory/src/config.js'
  );

  const config = resolveMem0PluginConfig({
    pluginConfig: {
      apiKey: 'plaintext-config-key',
      host: 'https://api.mem0.ai',
    },
    runtime: {
      cwd: '/tmp/hybridclaw',
    },
    credentialApiKey: 'secret-store-key',
    processEnvApiKey: 'env-key-should-be-ignored',
  });

  expect(config.apiKey).toBe('secret-store-key');

  const withoutCredential = resolveMem0PluginConfig({
    pluginConfig: {
      apiKey: 'plaintext-config-key',
      host: 'https://api.mem0.ai',
    },
    runtime: {
      cwd: '/tmp/hybridclaw',
    },
    processEnvApiKey: 'env-key-should-be-ignored',
  });

  expect(withoutCredential.apiKey).toBe('');
});

test('resolveMem0PluginConfig rejects invalid host values', async () => {
  const { resolveMem0PluginConfig } = await import(
    '../plugins/mem0-memory/src/config.js'
  );

  expect(() =>
    resolveMem0PluginConfig({
      pluginConfig: {
        host: 'not-a-url',
      },
      runtime: {
        cwd: '/tmp/hybridclaw',
      },
    }),
  ).toThrow('mem0-memory plugin config.host must be a valid absolute URL.');
});

test('mem0-memory injects prompt context, registers tools, and exposes command helpers', async () => {
  const homeDir = makeTempDir('hybridclaw-mem0-home-');
  const cwd = makeTempDir('hybridclaw-mem0-project-');
  const pluginDir = installBundledPlugin(cwd);
  const logPath = installMem0Stub(pluginDir, {
    getAll: {
      results: [
        { id: 'mem-profile-1', memory: 'User prefers dark mode.' },
        { id: 'mem-profile-2', memory: 'Project uses SQLite for local state.' },
      ],
    },
    search: {
      results: [
        {
          id: 'mem-search-1',
          memory: 'Project uses SQLite for local state.',
          score: 0.91,
        },
      ],
    },
    add: [{ id: 'mem-added-1', memory: 'stored' }],
  });

  process.env.MEM0_API_KEY = 'mem0-test-key';
  delete process.env.MEM0_TELEMETRY;

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'mem0-memory',
      enabled: true,
      config: {
        host: 'https://api.mem0.ai',
        searchLimit: 2,
        profileLimit: 2,
        maxInjectedChars: 2000,
        messageMaxChars: 1000,
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

  expect(manager.getToolDefinitions().map((tool) => tool.name)).toEqual([
    'mem0_conclude',
    'mem0_profile',
    'mem0_search',
  ]);

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
        content: 'What database does this project use?',
        created_at: '2026-04-11T10:00:00.000Z',
      },
    ],
  });

  expect(
    promptContext.some((section) => section.includes('Mem0 memory guide:')),
  ).toBe(true);
  expect(
    promptContext.some((section) => section.includes('Mem0 profile overview:')),
  ).toBe(true);
  expect(
    promptContext.some((section) =>
      section.includes('User prefers dark mode.'),
    ),
  ).toBe(true);
  expect(
    promptContext.some((section) =>
      section.includes(
        'Mem0 search results for the latest user question: What database does this project use?',
      ),
    ),
  ).toBe(true);
  expect(
    promptContext.some((section) =>
      section.includes('Project uses SQLite for local state.'),
    ),
  ).toBe(true);

  const statusCommand = manager.findCommand('mem0');
  expect(statusCommand).toBeDefined();
  await expect(
    statusCommand?.handler([], {
      sessionId: 'session-1',
      channelId: 'web',
      userId: 'user-1',
    }),
  ).resolves.toContain('Connection: ok');
  await expect(
    statusCommand?.handler(['search', 'SQLite'], {
      sessionId: 'session-1',
      channelId: 'web',
      userId: 'user-1',
    }),
  ).resolves.toContain('Project uses SQLite for local state.');

  const toolResult = await manager.executeTool({
    toolName: 'mem0_search',
    args: { query: 'SQLite', top_k: 2, rerank: false },
    sessionId: 'session-1',
    channelId: 'web',
  });
  expect(JSON.parse(toolResult)).toMatchObject({
    userId: 'user-1',
    query: 'SQLite',
    count: 1,
    results: [
      {
        id: 'mem-search-1',
        memory: 'Project uses SQLite for local state.',
        score: 0.91,
      },
    ],
  });

  const calls = readStubLog(logPath);
  expect(calls.some((entry) => entry.method === 'ping')).toBe(true);
  expect(calls).toContainEqual(
    expect.objectContaining({
      method: 'getAll',
      options: expect.objectContaining({
        api_version: 'v2',
        filters: { user_id: 'user-1' },
        page: 1,
        page_size: 2,
      }),
    }),
  );
  expect(calls).toContainEqual(
    expect.objectContaining({
      method: 'search',
      query: 'SQLite',
      options: expect.objectContaining({
        api_version: 'v2',
        filters: { user_id: 'user-1' },
        top_k: 2,
        rerank: false,
      }),
    }),
  );
  expect(process.env.MEM0_TELEMETRY).toBe('false');
});

test('mem0-memory syncs turns and mirrors native memory writes', async () => {
  const homeDir = makeTempDir('hybridclaw-mem0-home-');
  const cwd = makeTempDir('hybridclaw-mem0-project-');
  const pluginDir = installBundledPlugin(cwd);
  const logPath = installMem0Stub(pluginDir, {
    getAll: { results: [] },
    search: { results: [] },
    add: [{ id: 'mem-added-1', memory: 'stored' }],
  });

  process.env.MEM0_API_KEY = 'mem0-test-key';

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'mem0-memory',
      enabled: true,
      config: {
        syncTurns: true,
        mirrorNativeMemoryWrites: true,
        messageMaxChars: 200,
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
    sessionId: 'session-1',
    userId: 'user-1',
    agentId: 'main',
    workspacePath: cwd,
    messages: [
      {
        id: 1,
        session_id: 'session-1',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'Remember that I prefer dark mode.',
        created_at: '2026-04-11T10:00:00.000Z',
      },
      {
        id: 2,
        session_id: 'session-1',
        user_id: 'user-1',
        username: 'hybridclaw',
        role: 'assistant',
        content: 'Understood. I will keep dark mode in mind.',
        created_at: '2026-04-11T10:00:01.000Z',
      },
      {
        id: 3,
        session_id: 'session-1',
        user_id: 'user-1',
        username: 'system',
        role: 'system',
        content: 'ignored',
        created_at: '2026-04-11T10:00:02.000Z',
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
          '{"action":"append","target":"user","content":"User prefers dark mode."}',
        result: 'Appended 23 chars to USER.md',
        durationMs: 4,
      },
    ],
  });

  const addCalls = readStubLog(logPath).filter(
    (entry) => entry.method === 'add',
  );
  expect(addCalls).toHaveLength(2);
  expect(addCalls[0]).toMatchObject({
    messages: [
      { role: 'user', content: 'Remember that I prefer dark mode.' },
      {
        role: 'assistant',
        content: 'Understood. I will keep dark mode in mind.',
      },
    ],
    options: expect.objectContaining({
      api_version: 'v2',
      user_id: 'user-1',
      agent_id: 'main',
      metadata: expect.objectContaining({
        source: 'hybridclaw-turn',
        session_id: 'session-1',
      }),
    }),
  });
  expect(addCalls[1]).toMatchObject({
    messages: [
      {
        role: 'user',
        content: expect.stringContaining(
          'HybridClaw saved explicit memory in USER.md.',
        ),
      },
    ],
    options: expect.objectContaining({
      infer: false,
      user_id: 'user-1',
      agent_id: 'main',
      metadata: expect.objectContaining({
        source: 'hybridclaw-memory-write',
        action: 'append',
        memory_file_path: 'USER.md',
      }),
    }),
  });
});

test('mem0-memory prefetches profile on session_start and stores pre-compaction snapshot', async () => {
  const homeDir = makeTempDir('hybridclaw-mem0-home-');
  const cwd = makeTempDir('hybridclaw-mem0-project-');
  const pluginDir = installBundledPlugin(cwd);
  const logPath = installMem0Stub(pluginDir, {
    getAll: {
      results: [{ id: 'mem-profile-1', memory: 'User prefers dark mode.' }],
    },
    search: { results: [] },
    add: [{ id: 'mem-added-1', memory: 'stored' }],
  });

  process.env.MEM0_API_KEY = 'mem0-test-key';

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'mem0-memory',
      enabled: true,
      config: {
        host: 'https://api.mem0.ai',
        searchLimit: 2,
        profileLimit: 2,
        maxInjectedChars: 2000,
        messageMaxChars: 1000,
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

  await manager.notifySessionStart({
    sessionId: 'session-1',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
  });

  const promptContext = await manager.collectPromptContext({
    sessionId: 'session-1',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    recentMessages: [],
  });
  expect(
    promptContext.some((section) =>
      section.includes('User prefers dark mode.'),
    ),
  ).toBe(true);
  const afterPromptGetAllCount = readStubLog(logPath).filter(
    (entry) => entry.method === 'getAll',
  ).length;
  expect(afterPromptGetAllCount).toBe(1);

  await manager.notifyBeforeCompaction({
    sessionId: 'session-1',
    agentId: 'main',
    channelId: 'web',
    summary: 'Discussed deployment automation and preferred tone.',
    olderMessages: [
      {
        id: 10,
        session_id: 'session-1',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'Prefer concise status updates on deploys.',
        created_at: '2026-04-11T09:00:00.000Z',
      },
      {
        id: 11,
        session_id: 'session-1',
        user_id: 'user-1',
        username: 'assistant',
        role: 'assistant',
        content: 'Confirmed, will keep deploy summaries short.',
        created_at: '2026-04-11T09:00:30.000Z',
      },
    ],
  });

  const compactionAddCall = readStubLog(logPath).find(
    (entry) =>
      entry.method === 'add' &&
      typeof (entry.options as { metadata?: { source?: unknown } })?.metadata
        ?.source === 'string' &&
      (entry.options as { metadata: { source: string } }).metadata.source ===
        'hybridclaw-compaction',
  );
  expect(compactionAddCall).toBeDefined();
  expect(compactionAddCall).toMatchObject({
    messages: [
      {
        role: 'user',
        content: expect.stringContaining('[Pre-compaction context]'),
      },
    ],
    options: expect.objectContaining({
      infer: false,
      user_id: 'user-1',
      agent_id: 'main',
      metadata: expect.objectContaining({
        source: 'hybridclaw-compaction',
        session_id: 'session-1',
      }),
    }),
  });
  expect(
    (compactionAddCall as { messages: Array<{ content: string }> }).messages[0]
      .content,
  ).toContain('Summary:');
  expect(
    (compactionAddCall as { messages: Array<{ content: string }> }).messages[0]
      .content,
  ).toContain('user: Prefer concise status updates on deploys.');

  await manager.notifySessionEnd({
    sessionId: 'session-1',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
  });

  const secondContext = await manager.collectPromptContext({
    sessionId: 'session-1',
    userId: 'user-1',
    agentId: 'main',
    channelId: 'web',
    recentMessages: [],
  });
  const finalGetAllCount = readStubLog(logPath).filter(
    (entry) => entry.method === 'getAll',
  ).length;
  expect(finalGetAllCount).toBe(2);
  expect(
    secondContext.some((section) =>
      section.includes('User prefers dark mode.'),
    ),
  ).toBe(true);
});
