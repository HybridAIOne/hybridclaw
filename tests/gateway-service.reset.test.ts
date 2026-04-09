import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-gateway-reset-'),
  );
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

function updateLastActive(
  dbPath: string,
  sessionId: string,
  lastActive: string,
): void {
  const database = new Database(dbPath);
  try {
    database
      .prepare('UPDATE sessions SET last_active = ? WHERE id = ?')
      .run(lastActive, sessionId);
  } finally {
    database.close();
  }
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

async function seedSessionFixture() {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { DB_PATH, HYBRIDAI_ENABLE_RAG } = await import(
    '../src/config/config.ts'
  );
  const {
    initDatabase,
    updateSessionChatbot,
    updateSessionModel,
    updateSessionRag,
    updateSessionShowMode,
  } = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { DEFAULT_AGENT_ID } = await import('../src/agents/agent-types.ts');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const sessionId = 'session-reset';
  const session = memoryService.getOrCreateSession(sessionId, null, 'tui');
  updateSessionModel(session.id, 'openai-codex/gpt-5-codex');
  updateSessionChatbot(session.id, 'bot-reset');
  updateSessionRag(session.id, !HYBRIDAI_ENABLE_RAG);
  updateSessionShowMode(session.id, 'tools');
  memoryService.storeMessage({
    sessionId,
    userId: 'user-1',
    username: 'user',
    role: 'user',
    content: 'old user message',
  });
  memoryService.storeMessage({
    sessionId,
    userId: 'assistant-1',
    username: 'assistant',
    role: 'assistant',
    content: 'old assistant message',
  });
  memoryService.appendCanonicalMessages({
    agentId: DEFAULT_AGENT_ID,
    userId: 'user-1',
    newMessages: [
      {
        role: 'user',
        content: 'old user message',
        sessionId,
        channelId: 'tui',
      },
      {
        role: 'assistant',
        content: 'old assistant message',
        sessionId,
        channelId: 'tui',
      },
    ],
  });

  const agentId = DEFAULT_AGENT_ID;
  const workspacePath = agentWorkspaceDir(agentId);
  fs.mkdirSync(path.join(workspacePath, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, 'scripts', 'stale.txt'),
    'stale\n',
    'utf-8',
  );

  return {
    dbPath: DB_PATH,
    HYBRIDAI_ENABLE_RAG,
    DEFAULT_AGENT_ID,
    handleGatewayCommand,
    memoryService,
    sessionId,
    workspacePath,
  };
}

test('clear wipes canonical prompt context for the current agent and user', async () => {
  const fixture = await seedSessionFixture();

  expect(
    fixture.memoryService.getCanonicalContext({
      agentId: fixture.DEFAULT_AGENT_ID,
      userId: 'user-1',
    }).recent_messages,
  ).toHaveLength(2);

  const result = await fixture.handleGatewayCommand({
    sessionId: fixture.sessionId,
    guildId: null,
    channelId: 'tui',
    userId: 'user-1',
    args: ['clear'],
  });

  expect(result.kind).toBe('info');
  const activeSessionId = result.sessionId || fixture.sessionId;
  expect(
    fixture.memoryService.getConversationHistory(activeSessionId, 10),
  ).toHaveLength(0);
  expect(
    fixture.memoryService.getCanonicalContext({
      agentId: fixture.DEFAULT_AGENT_ID,
      userId: 'user-1',
    }),
  ).toEqual({
    summary: null,
    recent_messages: [],
  });
});

test('reset requires confirmation and reset no leaves session state intact', async () => {
  const fixture = await seedSessionFixture();

  const prompt = await fixture.handleGatewayCommand({
    sessionId: fixture.sessionId,
    guildId: null,
    channelId: 'tui',
    args: ['reset'],
  });

  expect(prompt.kind).toBe('info');
  if (prompt.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${prompt.kind}`);
  }
  expect(prompt.title).toBe('Confirm Reset');
  expect(prompt.text).toContain('reset yes');
  expect(prompt.text).toContain(fixture.workspacePath);
  expect(
    fs.existsSync(path.join(fixture.workspacePath, 'scripts', 'stale.txt')),
  ).toBe(true);
  expect(
    fixture.memoryService.getConversationHistory(fixture.sessionId, 10),
  ).toHaveLength(2);

  const cancelled = await fixture.handleGatewayCommand({
    sessionId: fixture.sessionId,
    guildId: null,
    channelId: 'tui',
    args: ['reset', 'no'],
  });

  expect(cancelled.kind).toBe('plain');
  expect(cancelled.text).toContain('Reset cancelled');
  expect(
    fs.existsSync(path.join(fixture.workspacePath, 'scripts', 'stale.txt')),
  ).toBe(true);
  expect(
    fixture.memoryService.getConversationHistory(fixture.sessionId, 10),
  ).toHaveLength(2);

  const missingPrompt = await fixture.handleGatewayCommand({
    sessionId: fixture.sessionId,
    guildId: null,
    channelId: 'tui',
    args: ['reset', 'yes'],
  });

  expect(missingPrompt.kind).toBe('error');
  expect(missingPrompt.text).toContain('Run `reset` first');
});

test('reset includes Discord button components for Discord command requests', async () => {
  const fixture = await seedSessionFixture();

  const prompt = await fixture.handleGatewayCommand({
    sessionId: fixture.sessionId,
    guildId: '123456789012345678',
    channelId: '234567890123456789',
    userId: '345678901234567890',
    args: ['reset'],
  });

  expect(prompt.kind).toBe('info');
  if (prompt.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${prompt.kind}`);
  }
  expect(prompt.components).toEqual([
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 4,
          label: 'Reset Session',
          custom_id: 'reset:yes:345678901234567890:session-reset',
        },
        {
          type: 2,
          style: 2,
          label: 'Cancel',
          custom_id: 'reset:no:345678901234567890:session-reset',
        },
      ],
    },
  ]);
});

test('gateway commands ignore malformed last_active timestamps instead of throwing', async () => {
  const fixture = await seedSessionFixture();
  updateLastActive(fixture.dbPath, fixture.sessionId, '');

  const result = await fixture.handleGatewayCommand({
    sessionId: fixture.sessionId,
    guildId: null,
    channelId: 'tui',
    args: ['help'],
  });

  expect(result.kind).toBe('info');
  expect(result.text).toContain(
    '`/agent [info|list|switch|create|model] [id] [--model <model>]`',
  );
  expect(
    fixture.memoryService.getConversationHistory(fixture.sessionId, 10),
  ).toHaveLength(2);
});

test('reset yes clears history, resets session defaults, and removes the workspace', async () => {
  const fixture = await seedSessionFixture();

  await fixture.handleGatewayCommand({
    sessionId: fixture.sessionId,
    guildId: null,
    channelId: 'tui',
    args: ['reset'],
  });

  const result = await fixture.handleGatewayCommand({
    sessionId: fixture.sessionId,
    guildId: null,
    channelId: 'tui',
    args: ['reset', 'yes'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Session Reset');
  expect(result.text).toContain('Deleted 2 messages');
  expect(result.text).toContain('Removed workspace');
  expect(result.text).toContain('model/chatbot/show settings reset');

  const activeSessionId = result.sessionId || fixture.sessionId;
  expect(
    fixture.memoryService.getConversationHistory(activeSessionId, 10),
  ).toHaveLength(0);
  expect(fs.existsSync(fixture.workspacePath)).toBe(false);

  const session = fixture.memoryService.getSessionById(activeSessionId);
  expect(session).toBeDefined();
  expect(session?.message_count).toBe(0);
  expect(session?.model).toBeNull();
  expect(session?.chatbot_id).toBeNull();
  expect(session?.enable_rag).toBe(fixture.HYBRIDAI_ENABLE_RAG ? 1 : 0);
  expect(session?.show_mode).toBe('all');
});
