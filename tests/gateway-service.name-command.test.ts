import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-name-command-',
});

async function load() {
  setupHome();
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { resolveTextChannelSlashCommands } = await import(
    '../src/gateway/text-channel-commands.ts'
  );
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  initDatabase({ quiet: true });

  // As a web chat turn arrives: parsed from the text, then dispatched.
  const send = async (text: string) => {
    const parsed = resolveTextChannelSlashCommands(text);
    expect(parsed).not.toBeNull();
    const result = await handleGatewayCommand({
      sessionId: 'app-main',
      guildId: null,
      channelId: 'web',
      args: parsed?.[0] ?? [],
      userId: 'user_a',
    });
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(result.text);
    } catch {}
    return { kind: result.kind, text: result.text, json };
  };
  const userFile = () => path.join(agentWorkspaceDir('main'), 'USER.md');
  return { send, userFile };
}

test('an app sets, reads and clears what the agent calls the user', async () => {
  const { send, userFile } = await load();

  expect((await send('/name --json')).json).toEqual({
    version: 1,
    name: null,
    full_name: null,
  });

  // A workspace without USER.md is set up from the template first.
  const set = await send('/name set Ben  van Dyke --json');
  expect(set.json).toEqual({
    version: 1,
    name: 'Ben van Dyke',
    full_name: null,
  });
  const user = fs.readFileSync(userFile(), 'utf-8');
  expect(user).toContain(
    '- **Name:**\n- **What to call them:** Ben van Dyke\n- **Email:**',
  );

  // Set again, it replaces the line in place, and a `$` stays as typed.
  fs.writeFileSync(
    userFile(),
    user.replace('- **Name:**', '- **Name:** Benjamin van Dyke'),
  );
  expect((await send('/name set $& Benny --json')).json).toEqual({
    version: 1,
    name: '$& Benny',
    full_name: 'Benjamin van Dyke',
  });
  const replaced = fs.readFileSync(userFile(), 'utf-8');
  expect(replaced.match(/What to call them/g)).toHaveLength(1);
  expect(replaced).toContain('- **What to call them:** $& Benny\n');

  // Cleared, the agent goes by the user's full name again.
  expect((await send('/name clear --json')).json).toEqual({
    version: 1,
    name: null,
    full_name: 'Benjamin van Dyke',
  });
  expect(fs.readFileSync(userFile(), 'utf-8')).toContain(
    '- **What to call them:**\n',
  );
  expect((await send('/name')).text).toBe(
    'The agent calls you Benjamin van Dyke.',
  );
});

test('a name is one line of at most 80 characters', async () => {
  const { send, userFile } = await load();

  const long = await send(`/name set ${'a'.repeat(81)} --json`);
  expect(long.kind).toBe('error');
  expect(fs.existsSync(userFile())).toBe(false);
  expect((await send('/name set --json')).kind).toBe('error');
  expect((await send('/name rename Ben')).kind).toBe('error');

  expect((await send('/name set <Ben> --json')).json).toMatchObject({
    name: 'Ben',
  });
});

test('apps find the command in help', async () => {
  const { send } = await load();

  expect((await send('/help')).text).toContain('`/name`');
});
