import { beforeAll, describe, expect, it, vi } from 'vitest';

import { isSharedAuthStatusTarget } from '../src/auth/auth-status.js';
import {
  AUTH_STATUS_TARGETS,
  AUTH_TARGETS,
} from '../src/auth/auth-targets.js';
import { GENERIC_PROVIDER_AUTH_DEFS } from '../src/auth/generic-provider-auth.js';
import { handleAuthCommand } from '../src/cli/auth-command.js';
import { printAuthUsage } from '../src/cli/help.js';
import { buildTuiSlashCommandDefinitions } from '../src/command-registry.js';
import {
  runtimeSecretsPath,
  saveNamedRuntimeSecrets,
} from '../src/security/runtime-secrets.js';
import { useCleanMocks } from './test-utils.ts';

useCleanMocks({ restoreAllMocks: true, unstubAllEnvs: true });

function captureLogs(): string[][] {
  return vi.spyOn(console, 'log').mockImplementation(() => {}).mock
    .calls as string[][];
}

const CLI_ONLY_STATUS_TARGETS = AUTH_TARGETS.filter(
  (target) => !(AUTH_STATUS_TARGETS as readonly string[]).includes(target),
);
const SHARED_STATUS_TARGETS = AUTH_STATUS_TARGETS.filter(
  isSharedAuthStatusTarget,
);

describe('hybridclaw auth usage', () => {
  it.each([
    'login',
    'status',
    'logout',
  ])('`auth %s` lists every auth target', (command) => {
    const logs = captureLogs();

    printAuthUsage();

    const line = logs
      .flat()
      .join('\n')
      .split('\n')
      .find((entry) => entry.trim().startsWith(`hybridclaw auth ${command} <`));
    expect(line?.match(/<([^>]+)>/)?.[1].split('|')).toEqual(AUTH_TARGETS);
  });
});

describe('TUI /auth status menu', () => {
  it('offers exactly the targets the gateway answers', () => {
    const auth = buildTuiSlashCommandDefinitions([]).find(
      (definition) => definition.name === 'auth',
    );

    expect(auth?.tuiMenuEntries?.map((entry) => entry.insertText)).toEqual(
      AUTH_STATUS_TARGETS.map((target) => `/auth status ${target}`),
    );
  });
});

describe('gateway auth status', () => {
  let handleGatewayCommand: typeof import('../src/gateway/gateway-service.js').handleGatewayCommand;

  beforeAll(async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    ({ handleGatewayCommand } = await import(
      '../src/gateway/gateway-service.ts'
    ));
    initDatabase({ quiet: true });
  });

  function authStatus(target: string) {
    return handleGatewayCommand({
      sessionId: `session-auth-status-${target}`,
      guildId: null,
      channelId: 'tui',
      args: ['auth', 'status', target],
    });
  }

  it.each(AUTH_STATUS_TARGETS)('answers %s', async (target) => {
    const result = await authStatus(target);

    expect(result.kind).toBe('info');
    expect(result.title).toMatch(/ Auth Status$/);
    expect(result.text).toContain('Config: ');
    expect(result.text).not.toContain('Path:');
  });

  it.each(
    CLI_ONLY_STATUS_TARGETS,
  )('answers CLI-only %s with a usage line naming every served target', async (target) => {
    const result = await authStatus(target);

    expect(result).toMatchObject({ kind: 'error', title: 'Usage' });
    expect(result.text).toContain(
      `auth status <${AUTH_STATUS_TARGETS.join('|')}>`,
    );
  });

  it.each(
    SHARED_STATUS_TARGETS,
  )('reports %s with the lines `hybridclaw auth status` prints after the secrets path', async (target) => {
    const logs = captureLogs();
    await handleAuthCommand(['status', target]);
    const cliText = logs.flat().join('\n');

    const result = await authStatus(target);

    expect(cliText).toBe(`Path: ${runtimeSecretsPath()}\n${result.text}`);
  });

  it.each(
    GENERIC_PROVIDER_AUTH_DEFS.map((def) => [def.id, def.envVarNames[0]]),
  )('reports %s configured from %s without printing the key', async (target, envVar) => {
    vi.stubEnv(envVar, 'test-key-value');

    const result = await authStatus(target);

    expect(result.text).toContain('Source: env');
    expect(result.text).toContain('API key: configured');
    expect(result.text).not.toContain('test-key-value');
  });

  it('reports the stored secret as the source when the env differs', async () => {
    saveNamedRuntimeSecrets({ GEMINI_API_KEY: 'test-stored-key' });
    vi.stubEnv('GOOGLE_API_KEY', 'test-env-key');

    try {
      const result = await authStatus('gemini');

      expect(result.text).toContain('Source: runtime-secrets');
      expect(result.text).not.toMatch(/test-(stored|env)-key/);
    } finally {
      saveNamedRuntimeSecrets({ GEMINI_API_KEY: null });
    }
  });

  it('reports Slack configured only when both tokens are set', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'test-bot-token');
    vi.stubEnv('SLACK_APP_TOKEN', '');

    const botOnly = await authStatus('slack');
    vi.stubEnv('SLACK_APP_TOKEN', 'test-app-token');
    const both = await authStatus('slack');

    expect(botOnly.text).toContain('Authenticated: no');
    expect(both.text).toContain('Authenticated: yes');
    expect(both.text).not.toMatch(/test-(bot|app)-token/);
  });
});
