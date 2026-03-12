import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

  const { HYBRIDAI_ENABLE_RAG } = await import('../src/config/config.ts');
  const {
    initDatabase,
    updateSessionChatbot,
    updateSessionModel,
    updateSessionRag,
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

  const agentId = DEFAULT_AGENT_ID;
  const workspacePath = agentWorkspaceDir(agentId);
  fs.mkdirSync(path.join(workspacePath, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, 'scripts', 'stale.txt'),
    'stale\n',
    'utf-8',
  );

  return {
    HYBRIDAI_ENABLE_RAG,
    handleGatewayCommand,
    memoryService,
    sessionId,
    workspacePath,
  };
}

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

  expect(
    fixture.memoryService.getConversationHistory(fixture.sessionId, 10),
  ).toHaveLength(0);
  expect(fs.existsSync(fixture.workspacePath)).toBe(false);

  const session = fixture.memoryService.getSessionById(fixture.sessionId);
  expect(session).toBeDefined();
  expect(session?.message_count).toBe(0);
  expect(session?.model).toBeNull();
  expect(session?.chatbot_id).toBeNull();
  expect(session?.enable_rag).toBe(fixture.HYBRIDAI_ENABLE_RAG ? 1 : 0);
});
