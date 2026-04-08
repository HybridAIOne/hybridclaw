import { expect, test } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-eval-command-',
});

test('eval command is restricted to local tui, web, and cli sessions', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-eval-discord',
    guildId: 'guild-1',
    channelId: 'discord-channel',
    args: ['eval', 'list'],
  });

  expect(result.kind).toBe('error');
  expect(result.text).toContain(
    'The `eval` command is only available from local TUI, web, or CLI sessions.',
  );
});

test('eval help is available through the gateway command path', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-eval-web',
    guildId: null,
    channelId: 'web',
    args: ['eval', 'list'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Eval');
  expect(result.text).toContain(
    '`/eval [--current-agent|--fresh-agent] [--ablate-system] [--include-prompt=<parts>] [--omit-prompt=<parts>] <shell command...>`',
  );
  expect(result.text).toContain('/eval tau2 [setup|run|status|stop|results]');
  expect(result.text).toContain('swebench-verified');
  expect(result.text).toContain('terminal-bench-2.0');
  expect(result.text).toContain('agentbench');
  expect(result.text).toContain('gaia');
  expect(result.text).not.toContain('tau2-bench');
});
