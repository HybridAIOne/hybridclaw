import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-gateway-bot-auth-'));
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
  vi.unstubAllGlobals();
  vi.doUnmock('../src/providers/hybridai-bots.ts');
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar(
    'HYBRIDCLAW_DISABLE_CONFIG_WATCHER',
    ORIGINAL_DISABLE_CONFIG_WATCHER,
  );
});

test('bot list returns an actionable message on HybridAI auth failure', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  vi.doMock('../src/providers/hybridai-bots.ts', () => ({
    fetchHybridAIBots: vi.fn(async () => {
      throw new Error('Failed to fetch bots: 401 UNAUTHORIZED');
    }),
  }));

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId: 'session-bot-auth',
    guildId: null,
    channelId: 'channel-bot-auth',
    args: ['bot', 'list'],
  });

  expect(result).toMatchObject({
    kind: 'error',
    text: 'HybridAI bot commands require valid HybridAI API credentials. Run `hybridclaw hybridai login` and try again.',
  });
});

test.each([
  {
    name: 'list',
    args: ['bot', 'list'],
  },
  {
    name: 'set',
    args: ['bot', 'set', 'Research Bot'],
  },
  {
    name: 'info',
    args: ['bot', 'info'],
  },
])('bot $name returns a provider-only message for non-HybridAI session models', async ({
  args,
  name,
}) => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();

  const fetchHybridAIBots = vi.fn(async () => [
    {
      id: 'bot-research',
      name: 'Research Bot',
    },
  ]);
  vi.doMock('../src/providers/hybridai-bots.ts', () => ({
    fetchHybridAIBots,
  }));

  const {
    getOrCreateSession,
    getRecentStructuredAuditForSession,
    getSessionById,
    initDatabase,
    updateSessionModel,
  } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  const sessionId = `session-bot-provider-${name}`;
  getOrCreateSession(sessionId, null, `channel-bot-provider-${name}`);
  updateSessionModel(sessionId, 'openai-codex/gpt-5.4');

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId,
    guildId: null,
    channelId: `channel-bot-provider-${name}`,
    args,
  });

  expect(result).toEqual({
    kind: 'plain',
    text: 'Only for hybridai provider',
  });
  expect(fetchHybridAIBots).not.toHaveBeenCalled();
  expect(getRecentStructuredAuditForSession(sessionId, 10)).toEqual([]);
  expect(getSessionById(sessionId)?.chatbot_id).toBeNull();
});
