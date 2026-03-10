import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;

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
});

test('bot list returns an actionable message on HybridAI auth failure', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
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
