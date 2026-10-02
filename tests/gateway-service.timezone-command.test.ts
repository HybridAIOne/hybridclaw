import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-timezone-command-',
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
  const { readUserTimezoneFile } = await import(
    '../container/shared/workspace-time.js'
  );
  initDatabase({ quiet: true });

  // As a web chat turn arrives: parsed from the text, then dispatched.
  const send = async (text: string) => {
    const parsed = resolveTextChannelSlashCommands(text);
    expect(parsed).not.toBeNull();
    const result = await handleGatewayCommand({
      sessionId: 'app-tz',
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
  // What schedules, the daily note and the prompt's time read.
  const runtimeZone = () => readUserTimezoneFile(userFile());
  return { send, userFile, runtimeZone };
}

test('an app sets the time zone the runtime reads from USER.md', async () => {
  const { send, userFile, runtimeZone } = await load();

  expect((await send('/timezone --json')).json).toEqual({
    version: 1,
    timezone: null,
  });

  // A workspace without USER.md is set up from the template first, and the
  // template's line is filled in.
  expect((await send('/timezone set Europe/Berlin --json')).json).toEqual({
    version: 1,
    timezone: 'Europe/Berlin',
  });
  expect(runtimeZone()).toBe('Europe/Berlin');
  const user = fs.readFileSync(userFile(), 'utf-8');
  expect(user.match(/\*\*Timezone:\*\*/g)).toHaveLength(1);
  expect(user).toContain('- **Pronouns:** _(optional)_\n- **Timezone:** Europe/Berlin\n');

  // The agent guessed a zone that isn't one and noted why. The runtime reads
  // the first word, and the reply names that word, not the note; set again,
  // the line is replaced whole.
  fs.writeFileSync(
    userFile(),
    user.replace(
      '- **Timezone:** Europe/Berlin',
      '- **Timezone:** Europe/Munich (inferred from the city)',
    ),
  );
  expect(runtimeZone()).toBe('Europe/Munich');
  expect((await send('/timezone --json')).json).toEqual({
    version: 1,
    timezone: null,
  });
  const invalid = (await send('/timezone')).text;
  expect(invalid).toContain('"Europe/Munich"');
  expect(invalid).not.toContain('inferred');
  expect((await send('/timezone set america/new_york --json')).json).toEqual({
    version: 1,
    timezone: 'America/New_York',
  });
  expect(runtimeZone()).toBe('America/New_York');
  expect(fs.readFileSync(userFile(), 'utf-8')).toContain(
    '- **Timezone:** America/New_York\n',
  );
  expect((await send('/timezone')).text).toBe(
    'Your time zone is America/New_York.',
  );

  expect((await send('/timezone clear --json')).json).toEqual({
    version: 1,
    timezone: null,
  });
  expect(runtimeZone()).toBeUndefined();
});

test('a USER.md without the line gets it after the name', async () => {
  const { send, userFile } = await load();

  fs.mkdirSync(path.dirname(userFile()), { recursive: true });
  fs.writeFileSync(
    userFile(),
    '# USER.md\n\n- **Name:** Ben\n- **What to call them:** Ben\n- **Notes:** none\n',
  );
  await send('/timezone set Asia/Tokyo --json');
  expect(fs.readFileSync(userFile(), 'utf-8')).toBe(
    '# USER.md\n\n- **Name:** Ben\n- **What to call them:** Ben\n- **Timezone:** Asia/Tokyo\n- **Notes:** none\n',
  );
});

test('only a zone name is taken', async () => {
  const { send, userFile } = await load();

  for (const text of [
    '/timezone set Mars/Olympus --json',
    '/timezone set +01:00 --json',
    '/timezone set Europe/Berlin (home) --json',
    '/timezone set --json',
    '/timezone move Europe/Berlin',
  ]) {
    expect((await send(text)).kind).toBe('error');
  }
  expect(fs.existsSync(userFile())).toBe(false);
});

test('apps find the command in help', async () => {
  const { send } = await load();

  expect((await send('/help')).text).toContain('`/timezone`');
});
