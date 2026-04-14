import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const ORIGINAL_HOME = process.env.HOME;

const makeTempHome = useTempDir('hybridclaw-show-');

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

useCleanMocks({
  cleanup: () => {
    restoreEnvVar('HOME', ORIGINAL_HOME);
  },
  resetModules: true,
});

test('show command reports and updates the session show mode', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  memoryService.getOrCreateSession('session-show', null, 'web');

  const initial = await handleGatewayCommand({
    sessionId: 'session-show',
    guildId: null,
    channelId: 'web',
    args: ['show'],
  });

  expect(initial.kind).toBe('info');
  if (initial.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${initial.kind}`);
  }
  expect(initial.text).toContain('Current: all');

  const updated = await handleGatewayCommand({
    sessionId: 'session-show',
    guildId: null,
    channelId: 'web',
    args: ['show', 'tools'],
  });

  expect(updated.kind).toBe('info');
  if (updated.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${updated.kind}`);
  }
  expect(updated.text).toContain('Current: tools');
  expect(memoryService.getSessionById('session-show')?.show_mode).toBe('tools');
});

test('show command rejects invalid modes', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-show-invalid',
    guildId: null,
    channelId: 'web',
    args: ['show', 'verbose'],
  });

  expect(result.kind).toBe('error');
  expect(result.text).toContain('Usage: `show [all|thinking|tools|none]`');
});
