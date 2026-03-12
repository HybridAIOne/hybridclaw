import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-agents-'));
  tempDirs.push(dir);
  return dir;
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveAgentForRequest prefers request, then session, then main agent defaults', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const {
    initAgentRegistry,
    listAgents,
    resolveAgentConfig,
    resolveAgentForRequest,
    resolveAgentModel,
  } = await import('../src/agents/agent-registry.ts');

  initDatabase({ quiet: true });
  initAgentRegistry({
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
    created_at: '2026-03-12T00:00:00.000Z',
    last_active: '2026-03-12T00:00:00.000Z',
  } as const;

  expect(resolveAgentForRequest({ session })).toEqual({
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
      'INSERT INTO kv_store (agent_id, key, value, version, updated_at) VALUES (?, ?, ?, ?, datetime(\'now\'))',
    )
    .run('ollama', 'memory:key', Buffer.from('null', 'utf8'), 1);
  legacyDb
    .prepare(
      'INSERT INTO kv_store (agent_id, key, value, version, updated_at) VALUES (?, ?, ?, ?, datetime(\'now\', \'+1 minute\'))',
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
  expect(sessionColumns.some((column) => column.name === 'agent_id')).toBe(
    true,
  );

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
    .prepare('SELECT COUNT(*) AS total FROM canonical_sessions WHERE user_id = ?')
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
