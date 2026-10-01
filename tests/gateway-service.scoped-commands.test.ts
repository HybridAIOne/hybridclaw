import { expect, test } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-scoped-commands-',
});

async function load() {
  setupHome();
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { DEVICE_TOKEN_ACTIONS, OWNER_DEVICE_TOKEN_ACTIONS } = await import(
    '../src/gateway/device-grants.ts'
  );
  const rbac = await import('../src/security/admin-rbac.ts');
  initDatabase({ quiet: true });
  // A web turn, as the HTTP gateway hands it on with the caller's actions.
  const run = (args: string[], adminActions?: string[]) =>
    handleGatewayCommand({
      sessionId: 'web-chat',
      guildId: null,
      channelId: 'web',
      args,
      userId: 'web-user',
      adminActions,
    });
  const roleActions = (role: string) =>
    rbac.adminActionClaimList({ role }) as string[];
  return { run, DEVICE_TOKEN_ACTIONS, OWNER_DEVICE_TOKEN_ACTIONS, roleActions };
}

test('a phone that may only chat cannot reach local secrets, env, config or memory', async () => {
  const { run, DEVICE_TOKEN_ACTIONS, OWNER_DEVICE_TOKEN_ACTIONS } =
    await load();
  // The local operator stores what a phone must not see.
  expect((await run(['secret', 'set', 'PHONE_TEST', 'hunter2'])).kind).not.toBe(
    'error',
  );
  expect((await run(['env', 'set', 'PHONE_ENV', 'plain-value'])).kind).not.toBe(
    'error',
  );

  for (const phone of [
    [...DEVICE_TOKEN_ACTIONS],
    [...OWNER_DEVICE_TOKEN_ACTIONS],
  ]) {
    for (const args of [
      ['secret', 'list'],
      ['secret', 'set', 'PHONE_TEST', 'overwritten'],
      ['secret', 'unset', 'PHONE_TEST'],
      ['secret', 'route', 'list'],
      ['env', 'list'],
      ['env', 'show', 'PHONE_ENV'],
      ['config'],
      ['config', 'get', 'voice'],
      ['memory', 'inspect'],
      ['policy', 'list'],
      ['auth', 'status', 'hybridai'],
      ['voice', 'info'],
      ['voice', 'call', '+15551234567'],
      ['speech', 'provider', 'openai'],
      ['skill', 'install', 'some-skill'],
      ['skill', 'unblock', 'some-skill'],
      ['plugin', 'enable', 'some-plugin'],
      ['agent', 'install', '/tmp/local.claw'],
    ]) {
      const result = await run(args, phone);
      expect(result.kind, args.join(' ')).toBe('error');
      expect(result.text, args.join(' ')).not.toContain('hunter2');
      expect(result.text, args.join(' ')).not.toContain('plain-value');
    }
  }
  // Nothing was overwritten or removed.
  expect((await run(['secret', 'list'])).text).toContain('PHONE_TEST');
  expect((await run(['env', 'list'])).text).toContain('PHONE_ENV=plain-value');
});

test('a scoped caller runs what its admin role allows', async () => {
  const { run, roleActions } = await load();
  const secretManager = roleActions('admin:secret-manager');
  const viewer = roleActions('admin.viewer');
  const owner = roleActions('admin:owner');

  expect((await run(['secret', 'set', 'TEAM_TEST', 'x'], owner)).kind).not.toBe(
    'error',
  );
  expect((await run(['secret', 'list'], secretManager)).text).toContain(
    'TEAM_TEST',
  );
  expect((await run(['secret', 'list'], viewer)).kind).toBe('error');
  // Env values are plaintext: reading them asks as much as changing config.
  expect((await run(['env', 'list'], secretManager)).kind).toBe('error');
  expect((await run(['env', 'list'], owner)).kind).not.toBe('error');
  expect((await run(['config'], viewer)).kind).not.toBe('error');
  expect((await run(['config', 'set', 'voice.enabled', 'true'], viewer)).kind).toBe(
    'error',
  );
  // A wildcard claim is the local operator's equal.
  expect((await run(['env', 'list'], ['*'])).kind).not.toBe('error');
});
