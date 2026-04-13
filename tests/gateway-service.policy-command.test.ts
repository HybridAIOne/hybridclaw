import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;

function makeTempHome(): string {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-home-'));
  fs.mkdirSync(path.join(homeDir, '.hybridclaw'), { recursive: true });
  return homeDir;
}

afterEach(() => {
  vi.resetModules();
  if (ORIGINAL_HOME) {
    process.env.HOME = ORIGINAL_HOME;
  } else {
    delete process.env.HOME;
  }
});

test('policy command runs from local TUI sessions', async () => {
  process.env.HOME = makeTempHome();
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const allow = await handleGatewayCommand({
    sessionId: 'session-policy-local',
    guildId: null,
    channelId: 'tui',
    args: ['policy', 'allow', 'api.github.com', '--agent', 'research'],
  });
  expect(allow.kind).toBe('plain');
  expect(allow.text).toContain('Rule added: [2] ALLOW api.github.com:443');

  const list = await handleGatewayCommand({
    sessionId: 'session-policy-local',
    guildId: null,
    channelId: 'tui',
    args: ['policy', 'list', '--agent', 'research'],
  });
  expect(list.kind).toBe('info');
  if (list.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${list.kind}`);
  }
  expect(list.title).toBe('Policy Rules');
  expect(list.text).toContain('api.github.com');
  expect(list.text).toContain('research');
});

test('policy command is rejected outside local TUI/web sessions', async () => {
  process.env.HOME = makeTempHome();
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-policy-remote',
    guildId: 'guild-1',
    channelId: 'discord-channel-1',
    args: ['policy', 'status'],
  });

  expect(result.kind).toBe('error');
  if (result.kind !== 'error') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Policy Restricted');
  expect(result.text).toContain('only available from local TUI/web sessions');
});
