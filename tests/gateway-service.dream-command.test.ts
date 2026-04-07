import { expect, test, vi } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-dream-',
});

test('dream command runs memory consolidation on demand', async () => {
  setupHome();

  const { getRuntimeConfig } = await import('../src/config/runtime-config.js');
  const { initDatabase } = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const decaySpy = vi.spyOn(memoryService, 'setConsolidationDecayRate');
  const consolidateSpy = vi
    .spyOn(memoryService, 'consolidateMemories')
    .mockReturnValue({
      memoriesDecayed: 7,
      dailyFilesCompiled: 3,
      workspacesUpdated: 2,
      durationMs: 1_250,
    });

  const result = await handleGatewayCommand({
    sessionId: 'session-dream',
    guildId: null,
    channelId: 'web',
    args: ['dream', 'now'],
  });

  expect(decaySpy).toHaveBeenCalledWith(getRuntimeConfig().memory.decayRate);
  expect(consolidateSpy).toHaveBeenCalledTimes(1);
  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Memory Consolidated');
  expect(result.text).toContain('Memories decayed: 7');
  expect(result.text).toContain('Daily files compiled: 3');
  expect(result.text).toContain('Workspaces updated: 2');
  expect(result.text).toContain('Duration: 1.3s');
});

test('dream command reports consolidation failures', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  vi.spyOn(memoryService, 'consolidateMemories').mockImplementation(() => {
    throw new Error('disk busy');
  });

  const result = await handleGatewayCommand({
    sessionId: 'session-dream-error',
    guildId: null,
    channelId: 'web',
    args: ['dream', 'now'],
  });

  expect(result.kind).toBe('error');
  expect(result.title).toBe('Memory Consolidation Failed');
  expect(result.text).toContain('disk busy');
});

test('dream command is restricted to local TUI/web sessions', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const consolidateSpy = vi.spyOn(memoryService, 'consolidateMemories');

  const result = await handleGatewayCommand({
    sessionId: 'session-dream-remote',
    guildId: 'guild-1',
    channelId: 'discord:channel-1',
    args: ['dream', 'now'],
  });

  expect(consolidateSpy).not.toHaveBeenCalled();
  expect(result.kind).toBe('error');
  expect(result.title).toBe('Dream Restricted');
  expect(result.text).toContain('only available from local TUI/web sessions');
});

test('dream command reports scheduler status by default', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-dream-status',
    guildId: null,
    channelId: 'web',
    args: ['dream'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Dream Status');
  expect(result.text).toContain('Scheduler: enabled');
  expect(result.text).toContain('Cadence: every 24h');
  expect(result.text).toContain('Usage: `dream on|off|now`');
});

test('dream command can disable and re-enable scheduled consolidation', async () => {
  setupHome();

  const { getRuntimeConfig } = await import('../src/config/runtime-config.js');
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const disabled = await handleGatewayCommand({
    sessionId: 'session-dream-off',
    guildId: null,
    channelId: 'web',
    args: ['dream', 'off'],
  });

  expect(disabled.kind).toBe('plain');
  expect(disabled.text).toContain('Dream scheduling disabled');
  expect(getRuntimeConfig().memory.consolidationIntervalHours).toBe(0);

  const enabled = await handleGatewayCommand({
    sessionId: 'session-dream-on',
    guildId: null,
    channelId: 'web',
    args: ['dream', 'on'],
  });

  expect(enabled.kind).toBe('plain');
  expect(enabled.text).toContain('Dream scheduling enabled');
  expect(getRuntimeConfig().memory.consolidationIntervalHours).toBe(24);
});
