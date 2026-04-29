import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const ORIGINAL_HOME = process.env.HOME;

const makeTempHome = useTempDir('hybridclaw-agents-');

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

useCleanMocks({
  restoreAllMocks: true,
  cleanup: async () => {
    const { resetAgentRegistryForTesting } = await import(
      '../src/agents/agent-registry.ts'
    );
    resetAgentRegistryForTesting();
    restoreEnvVar('HOME', ORIGINAL_HOME);
  },
  resetModules: true,
  unmock: ['../src/logger.js'],
});

test('resolveAgentForRequest prefers request, then session, then configured default agent', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const {
    initAgentRegistry,
    listAgents,
    resolveAgentConfig,
    resolveAgentForRequest,
    resolveAgentModel,
  } = await import('../src/agents/agent-registry.ts');

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.agents.defaultAgentId = 'research';
    draft.agents.defaults = {
      chatbotId: 'bot-default',
    };
    draft.agents.list = [
      {
        id: 'main',
        name: 'Main Agent',
        model: 'gpt-5-mini',
      },
      {
        id: 'research',
        name: 'Research Agent',
        model: {
          primary: 'ollama/llama3.2',
          fallbacks: ['gpt-5-mini'],
        },
        chatbotId: 'bot-research',
      },
    ];
  });
  initAgentRegistry({
    defaultAgentId: 'research',
    defaults: {
      chatbotId: 'bot-default',
    },
    list: [
      {
        id: 'main',
        name: 'Main Agent',
        model: 'gpt-5-mini',
      },
      {
        id: 'research',
        name: 'Research Agent',
        model: {
          primary: 'ollama/llama3.2',
          fallbacks: ['gpt-5-mini'],
        },
        chatbotId: 'bot-research',
      },
    ],
  });

  expect(listAgents().map((agent) => agent.id)).toEqual(['main', 'research']);

  const researchAgent = resolveAgentConfig('research');
  expect(researchAgent.model).toEqual({
    primary: 'ollama/llama3.2',
    fallbacks: ['gpt-5-mini'],
  });
  expect(resolveAgentModel(researchAgent)).toBe('ollama/llama3.2');

  const session = {
    id: 'session-1',
    guild_id: null,
    channel_id: 'tui',
    agent_id: 'research',
    chatbot_id: null,
    model: null,
    enable_rag: 1,
    message_count: 0,
    session_summary: null,
    summary_updated_at: null,
    compaction_count: 0,
    memory_flush_at: null,
    full_auto_enabled: 0,
    full_auto_prompt: null,
    full_auto_started_at: null,
    show_mode: 'all',
    created_at: '2026-03-12T00:00:00.000Z',
    last_active: '2026-03-12T00:00:00.000Z',
  } as const;

  expect(resolveAgentForRequest({ session })).toEqual({
    agentId: 'research',
    model: 'ollama/llama3.2',
    chatbotId: 'bot-research',
  });

  expect(resolveAgentForRequest()).toEqual({
    agentId: 'research',
    model: 'ollama/llama3.2',
    chatbotId: 'bot-research',
  });

  expect(
    resolveAgentForRequest({
      agentId: 'main',
      session,
      model: 'anthropic/claude-3-7-sonnet',
      chatbotId: '',
    }),
  ).toEqual({
    agentId: 'main',
    model: 'anthropic/claude-3-7-sonnet',
    chatbotId: '',
  });
});

test('agent skill allowlists persist through runtime config normalization and the registry', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { getAgentById, initAgentRegistry, resolveAgentConfig } = await import(
    '../src/agents/agent-registry.ts'
  );

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.agents.list = [
      {
        id: 'main',
        name: 'Main Agent',
      },
      {
        id: 'writer',
        name: 'Writer Agent',
        skills: [' draft-outline ', 'copy-edit', 'draft-outline'],
      },
      {
        id: 'silent',
        name: 'Silent Agent',
        skills: [],
      },
    ];
  });
  initAgentRegistry({
    list: [
      {
        id: 'main',
        name: 'Main Agent',
      },
      {
        id: 'writer',
        name: 'Writer Agent',
        skills: [' draft-outline ', 'copy-edit', 'draft-outline'],
      },
      {
        id: 'silent',
        name: 'Silent Agent',
        skills: [],
      },
    ],
  });

  expect(resolveAgentConfig('writer').skills).toEqual([
    'draft-outline',
    'copy-edit',
  ]);
  expect(getAgentById('writer')?.skills).toEqual([
    'draft-outline',
    'copy-edit',
  ]);
  expect(resolveAgentConfig('silent').skills).toEqual([]);
  expect(getAgentById('silent')?.skills).toEqual([]);
});

test('agent owner, role, and CV persist through runtime config and registry', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { updateRuntimeConfig, getRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { getAgentById, initAgentRegistry, resolveAgentConfig } = await import(
    '../src/agents/agent-registry.ts'
  );

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.agents.list = [
      {
        id: 'main',
        name: 'Main Agent',
      },
      {
        id: 'analyst',
        reportsTo: 'main',
      },
      {
        id: 'writer',
        reportsTo: 'main',
      },
      {
        id: 'charly',
        name: 'Charly',
        owner: '  benedikt  ',
        role: ' Researcher ',
        reportsTo: ' main ',
        delegatesTo: [' analyst ', 'analyst', ''],
        peers: ['writer', ' writer '],
        cv: {
          summary: '  Senior coworker  ',
          capabilities: [' research ', 'writing', 'research'],
          asset: 'agents/charly/CV.md',
        },
        escalationTarget: {
          channel: ' slack:COPS ',
          recipient: ' ops-lead ',
        },
      },
    ];
  });

  // Runtime config normalization should trim strings and dedupe capability list.
  const persistedConfig = getRuntimeConfig().agents.list?.find(
    (entry) => entry.id === 'charly',
  );
  expect(persistedConfig?.owner).toBe('benedikt');
  expect(persistedConfig?.role).toBe('Researcher');
  expect(persistedConfig?.reportsTo).toBe('main');
  expect(persistedConfig?.delegatesTo).toEqual(['analyst']);
  expect(persistedConfig?.peers).toEqual(['writer']);
  expect(persistedConfig?.cv).toEqual({
    summary: 'Senior coworker',
    capabilities: ['research', 'writing'],
    asset: 'agents/charly/CV.md',
  });
  expect(persistedConfig?.escalationTarget).toEqual({
    channel: 'slack:COPS',
    recipient: 'ops-lead',
  });

  initAgentRegistry({
    list: [
      {
        id: 'main',
        name: 'Main Agent',
      },
      {
        id: 'analyst',
        reportsTo: 'main',
      },
      {
        id: 'writer',
        reportsTo: 'main',
      },
      {
        id: 'charly',
        name: 'Charly',
        owner: 'benedikt',
        role: 'Researcher',
        reportsTo: 'main',
        delegatesTo: ['analyst'],
        peers: ['writer'],
        cv: {
          summary: 'Senior coworker',
          capabilities: ['research', 'writing'],
          asset: 'agents/charly/CV.md',
        },
        escalationTarget: {
          channel: 'slack:COPS',
          recipient: 'ops-lead',
        },
      },
    ],
  });

  const resolved = resolveAgentConfig('charly');
  expect(resolved.owner).toBe('benedikt');
  expect(resolved.role).toBe('Researcher');
  expect(resolved.reportsTo).toBe('main');
  expect(resolved.delegatesTo).toEqual(['analyst']);
  expect(resolved.peers).toEqual(['writer']);
  expect(resolved.cv).toEqual({
    summary: 'Senior coworker',
    capabilities: ['research', 'writing'],
    asset: 'agents/charly/CV.md',
  });
  expect(resolved.escalationTarget).toEqual({
    channel: 'slack:COPS',
    recipient: 'ops-lead',
  });

  // Round-trip through SQLite confirms persistence.
  const stored = getAgentById('charly');
  expect(stored?.owner).toBe('benedikt');
  expect(stored?.role).toBe('Researcher');
  expect(stored?.reportsTo).toBe('main');
  expect(stored?.delegatesTo).toEqual(['analyst']);
  expect(stored?.peers).toEqual(['writer']);
  expect(stored?.cv).toEqual({
    summary: 'Senior coworker',
    capabilities: ['research', 'writing'],
    asset: 'agents/charly/CV.md',
  });
  expect(stored?.escalationTarget).toEqual({
    channel: 'slack:COPS',
    recipient: 'ops-lead',
  });
});

test('agent registry rejects cyclic reports_to relationships', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { initAgentRegistry } = await import('../src/agents/agent-registry.ts');

  initDatabase({ quiet: true });
  expect(() =>
    initAgentRegistry({
      list: [
        { id: 'main', name: 'Main Agent' },
        { id: 'design', reportsTo: 'ops' },
        { id: 'ops', reportsTo: 'design' },
      ],
    }),
  ).toThrow('Agent reports_to cycle detected: design -> ops -> design.');
});

test('legacy agents without org-chart fields load cleanly after migration v26', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const dbPath = path.join(homeDir, 'data', 'hybridclaw.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const legacyDb = new Database(dbPath);
  legacyDb.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      display_name TEXT,
      image_asset TEXT,
      model TEXT,
      skills TEXT,
      chatbot_id TEXT,
      enable_rag INTEGER DEFAULT 1,
      workspace TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  legacyDb
    .prepare(
      `INSERT INTO agents (id, name, display_name)
       VALUES (?, ?, ?)`,
    )
    .run('charly', 'Charly', 'Charly the Coworker');
  legacyDb.pragma('user_version = 20');
  legacyDb.close();

  const { initDatabase } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true, dbPath });

  const migratedDb = new Database(dbPath, { readonly: true });
  const columns = migratedDb.pragma('table_info(agents)') as Array<{
    name: string;
  }>;
  expect(columns.some((column) => column.name === 'owner')).toBe(true);
  expect(columns.some((column) => column.name === 'role')).toBe(true);
  expect(columns.some((column) => column.name === 'cv')).toBe(true);
  expect(columns.some((column) => column.name === 'escalation_target')).toBe(
    true,
  );
  expect(columns.some((column) => column.name === 'reports_to')).toBe(true);
  expect(columns.some((column) => column.name === 'delegates_to')).toBe(true);
  expect(columns.some((column) => column.name === 'peers')).toBe(true);

  const userVersion = migratedDb.pragma('user_version', { simple: true });
  expect(userVersion).toBeGreaterThanOrEqual(26);

  const charly = migratedDb
    .prepare(
      'SELECT id, name, owner, role, reports_to, delegates_to, peers, cv, escalation_target FROM agents WHERE id = ?',
    )
    .get('charly') as {
    id: string;
    name: string;
    owner: string | null;
    role: string | null;
    reports_to: string | null;
    delegates_to: string | null;
    peers: string | null;
    cv: string | null;
    escalation_target: string | null;
  };
  expect(charly).toMatchObject({
    id: 'charly',
    name: 'Charly',
    owner: null,
    role: null,
    reports_to: null,
    delegates_to: null,
    peers: null,
    cv: null,
    escalation_target: null,
  });
  migratedDb.close();

  const { getAgentById } = await import('../src/agents/agent-registry.ts');
  expect(getAgentById('charly')).toMatchObject({
    id: 'charly',
    name: 'Charly',
    displayName: 'Charly the Coworker',
  });
});

test('warns and ignores malformed persisted agent skill allowlists', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const warnMock = vi.fn();
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn: warnMock,
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(() => ({
        warn: warnMock,
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        trace: vi.fn(),
      })),
    },
  }));

  const dbPath = path.join(homeDir, 'data', 'hybridclaw.db');
  const { initDatabase } = await import('../src/memory/db.ts');
  const { getAgentById } = await import('../src/agents/agent-registry.ts');

  initDatabase({ quiet: true, dbPath });
  const rawDb = new Database(dbPath);
  rawDb
    .prepare(
      `INSERT INTO agents (id, name, skills, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .run('writer', 'Writer Agent', '{broken-json');
  rawDb.close();

  const agent = getAgentById('writer');
  expect(agent).toMatchObject({
    id: 'writer',
    name: 'Writer Agent',
  });
  expect(agent?.skills).toBeUndefined();
  expect(warnMock).toHaveBeenCalledWith(
    { rawSkills: '{broken-json' },
    'Failed to parse persisted agent skills configuration',
  );
});

test('warns without logging malformed persisted agent CV payloads', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const warnMock = vi.fn();
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn: warnMock,
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(() => ({
        warn: warnMock,
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        trace: vi.fn(),
      })),
    },
  }));

  const dbPath = path.join(homeDir, 'data', 'hybridclaw.db');
  const { initDatabase } = await import('../src/memory/db.ts');
  const { getAgentById } = await import('../src/agents/agent-registry.ts');

  initDatabase({ quiet: true, dbPath });
  const rawCv = '{"summary":"Benedikt lives at Example Street"';
  const rawDb = new Database(dbPath);
  rawDb
    .prepare(
      `INSERT INTO agents (id, name, cv, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .run('researcher', 'Researcher Agent', rawCv);
  rawDb.close();

  const agent = getAgentById('researcher');
  expect(agent).toMatchObject({
    id: 'researcher',
    name: 'Researcher Agent',
  });
  expect(agent?.cv).toBeUndefined();
  expect(warnMock).toHaveBeenCalledWith(
    { cvLength: rawCv.length },
    'Failed to parse persisted agent CV configuration',
  );
  expect(JSON.stringify(warnMock.mock.calls)).not.toContain('Benedikt');
});

test('initAgentRegistry migrates the first legacy workspace to main', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const legacyWorkspace = agentWorkspaceDir('ollama');
  fs.mkdirSync(legacyWorkspace, { recursive: true });
  fs.writeFileSync(path.join(legacyWorkspace, 'MEMORY.md'), 'legacy\n', 'utf8');

  const { initDatabase } = await import('../src/memory/db.ts');
  const { initAgentRegistry } = await import('../src/agents/agent-registry.ts');
  initDatabase({ quiet: true });
  initAgentRegistry({ list: [{ id: 'main' }] });

  const mainWorkspace = agentWorkspaceDir('main');
  expect(fs.existsSync(path.join(mainWorkspace, 'MEMORY.md'))).toBe(true);
  expect(fs.existsSync(legacyWorkspace)).toBe(false);
});

test('initAgentRegistry migrates only the first legacy workspace and warns about the rest', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const warnMock = vi.fn();
  const infoMock = vi.fn();
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn: warnMock,
      info: infoMock,
      debug: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(() => ({
        warn: warnMock,
        info: infoMock,
        debug: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        trace: vi.fn(),
      })),
    },
  }));

  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const ollamaWorkspace = agentWorkspaceDir('ollama');
  const vllmWorkspace = agentWorkspaceDir('vllm');
  fs.mkdirSync(ollamaWorkspace, { recursive: true });
  fs.mkdirSync(vllmWorkspace, { recursive: true });
  fs.writeFileSync(path.join(ollamaWorkspace, 'MEMORY.md'), 'ollama\n', 'utf8');
  fs.writeFileSync(path.join(vllmWorkspace, 'MEMORY.md'), 'vllm\n', 'utf8');

  const { initDatabase } = await import('../src/memory/db.ts');
  const { initAgentRegistry } = await import('../src/agents/agent-registry.ts');
  initDatabase({ quiet: true });
  initAgentRegistry({ list: [{ id: 'main' }] });

  const mainWorkspace = agentWorkspaceDir('main');
  expect(fs.readFileSync(path.join(mainWorkspace, 'MEMORY.md'), 'utf8')).toBe(
    'ollama\n',
  );
  expect(fs.existsSync(ollamaWorkspace)).toBe(false);
  expect(fs.existsSync(path.join(vllmWorkspace, 'MEMORY.md'))).toBe(true);

  expect(warnMock).toHaveBeenCalledWith(
    {
      orphanedLegacyWorkspaceDirs: [path.dirname(vllmWorkspace)],
    },
    'Additional legacy agent workspaces remain on disk after migration',
  );
});

test('database migration v6 adds agents and backfills legacy agent ids to main', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const dbPath = path.join(homeDir, 'data', 'hybridclaw.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const legacyDb = new Database(dbPath);
  legacyDb.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      guild_id TEXT,
      channel_id TEXT NOT NULL,
      chatbot_id TEXT,
      model TEXT,
      enable_rag INTEGER DEFAULT 1,
      message_count INTEGER DEFAULT 0,
      session_summary TEXT,
      summary_updated_at TEXT,
      compaction_count INTEGER DEFAULT 0,
      memory_flush_at TEXT,
      full_auto_enabled INTEGER NOT NULL DEFAULT 0,
      full_auto_prompt TEXT,
      full_auto_started_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      last_active TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE kv_store (
      agent_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value BLOB NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, key)
    );

    CREATE TABLE canonical_sessions (
      canonical_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      messages TEXT NOT NULL DEFAULT '[]',
      compaction_cursor INTEGER NOT NULL DEFAULT 0,
      compacted_summary TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, user_id)
    );

    CREATE TABLE usage_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0.0,
      tool_calls INTEGER NOT NULL DEFAULT 0
    );
  `);
  legacyDb
    .prepare(
      `INSERT INTO sessions (
         id,
         guild_id,
         channel_id,
         chatbot_id,
         model,
         enable_rag,
         message_count,
         full_auto_enabled
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'session-v5',
      null,
      'tui',
      'bot-legacy',
      'openai-codex/gpt-5-codex',
      1,
      0,
      0,
    );
  legacyDb
    .prepare(
      "INSERT INTO kv_store (agent_id, key, value, version, updated_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run('ollama', 'memory:key', Buffer.from('null', 'utf8'), 1);
  legacyDb
    .prepare(
      "INSERT INTO kv_store (agent_id, key, value, version, updated_at) VALUES (?, ?, ?, ?, datetime('now', '+1 minute'))",
    )
    .run(
      'vllm',
      'memory:key',
      Buffer.from(JSON.stringify({ winner: 'vllm' }), 'utf8'),
      3,
    );
  legacyDb
    .prepare(
      `INSERT INTO canonical_sessions (
         canonical_id,
         agent_id,
         user_id,
         messages,
         compaction_cursor,
         compacted_summary,
         message_count,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(
      'canon-1',
      'openai-codex',
      'user-1',
      JSON.stringify([
        {
          role: 'user',
          content: 'first provider note',
          session_id: 'session-v5',
          channel_id: 'tui',
          created_at: '2026-03-12T10:00:00.000Z',
        },
      ]),
      0,
      'summary from codex',
      1,
    );
  legacyDb
    .prepare(
      `INSERT INTO canonical_sessions (
         canonical_id,
         agent_id,
         user_id,
         messages,
         compaction_cursor,
         compacted_summary,
         message_count,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+1 minute'), datetime('now', '+1 minute'))`,
    )
    .run(
      'canon-2',
      'vllm',
      'user-1',
      JSON.stringify([
        {
          role: 'assistant',
          content: 'second provider note',
          session_id: 'session-v5',
          channel_id: 'tui',
          created_at: '2026-03-12T10:01:00.000Z',
        },
      ]),
      0,
      'summary from vllm',
      1,
    );
  legacyDb
    .prepare(
      `INSERT INTO usage_events (
         id,
         session_id,
         agent_id,
         timestamp,
         model,
         input_tokens,
         output_tokens,
         total_tokens,
         cost_usd,
         tool_calls
       ) VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'usage-1',
      'session-v5',
      'anthropic',
      'anthropic/claude-3-7-sonnet',
      10,
      20,
      30,
      0.1,
      0,
    );
  legacyDb.pragma('user_version = 5');
  legacyDb.close();

  const { initDatabase } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true, dbPath });

  const migratedDb = new Database(dbPath, { readonly: true });
  const sessionColumns = migratedDb.pragma('table_info(sessions)') as Array<{
    name: string;
  }>;
  const agentColumns = migratedDb.pragma('table_info(agents)') as Array<{
    name: string;
  }>;
  expect(sessionColumns.some((column) => column.name === 'agent_id')).toBe(
    true,
  );
  expect(agentColumns.some((column) => column.name === 'display_name')).toBe(
    true,
  );
  expect(agentColumns.some((column) => column.name === 'image_asset')).toBe(
    true,
  );
  expect(agentColumns.some((column) => column.name === 'skills')).toBe(true);

  const sessionRow = migratedDb
    .prepare('SELECT agent_id FROM sessions WHERE id = ?')
    .get('session-v5') as { agent_id: string };
  const kvRow = migratedDb
    .prepare('SELECT agent_id, value, version FROM kv_store WHERE key = ?')
    .get('memory:key') as { agent_id: string; value: Buffer; version: number };
  const canonicalRow = migratedDb
    .prepare(
      'SELECT canonical_id, agent_id, messages, compacted_summary, message_count FROM canonical_sessions WHERE agent_id = ? AND user_id = ?',
    )
    .get('main', 'user-1') as {
    canonical_id: string;
    agent_id: string;
    messages: string;
    compacted_summary: string | null;
    message_count: number;
  };
  const usageRow = migratedDb
    .prepare('SELECT agent_id FROM usage_events WHERE id = ?')
    .get('usage-1') as { agent_id: string };
  const agentRow = migratedDb
    .prepare('SELECT id FROM agents WHERE id = ?')
    .get('main') as { id: string } | undefined;
  const canonicalCount = migratedDb
    .prepare(
      'SELECT COUNT(*) AS total FROM canonical_sessions WHERE user_id = ?',
    )
    .get('user-1') as { total: number };
  const kvCount = migratedDb
    .prepare('SELECT COUNT(*) AS total FROM kv_store WHERE key = ?')
    .get('memory:key') as { total: number };

  expect(sessionRow.agent_id).toBe('main');
  expect(kvRow.agent_id).toBe('main');
  expect(JSON.parse(kvRow.value.toString('utf8'))).toEqual({ winner: 'vllm' });
  expect(kvRow.version).toBe(3);
  expect(canonicalRow.agent_id).toBe('main');
  expect(canonicalRow.canonical_id).toBe('main:user-1');
  expect(JSON.parse(canonicalRow.messages)).toHaveLength(2);
  expect(canonicalRow.compacted_summary).toContain('summary from codex');
  expect(canonicalRow.compacted_summary).toContain('summary from vllm');
  expect(canonicalRow.message_count).toBe(2);
  expect(usageRow.agent_id).toBe('main');
  expect(agentRow?.id).toBe('main');
  expect(canonicalCount.total).toBe(1);
  expect(kvCount.total).toBe(1);
  migratedDb.close();
});
