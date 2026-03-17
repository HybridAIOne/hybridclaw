import { expect, test, vi } from 'vitest';

async function importFreshSessionContextModules() {
  vi.resetModules();
  const channelModule = await import('../src/channels/channel.js');
  const channelRegistryModule = await import(
    '../src/channels/channel-registry.js'
  );
  const sessionContextModule = await import(
    '../src/session/session-context.js'
  );
  return {
    ...channelModule,
    ...channelRegistryModule,
    ...sessionContextModule,
  };
}

test('buildSessionContext assembles normalized session fields', async () => {
  const { buildSessionContext } = await importFreshSessionContextModules();

  const context = buildSessionContext({
    source: {
      channelKind: 'discord',
      chatId: ' 1475079601968648386 ',
      chatType: 'channel',
      userId: ' 123456 ',
      userName: ' alice ',
      guildId: ' 987654 ',
      guildName: ' Ops ',
    },
    agentId: ' main ',
    sessionId: ' sess_20260316_185427_1a2b3c4d ',
    sessionKey: ' agent:main:discord:channel:1475079601968648386 ',
  });

  expect(context).toEqual({
    source: {
      channelKind: 'discord',
      chatId: '1475079601968648386',
      chatType: 'channel',
      userId: '123456',
      userName: 'alice',
      guildId: '987654',
      guildName: 'Ops',
    },
    agentId: 'main',
    sessionId: 'sess_20260316_185427_1a2b3c4d',
    sessionKey: 'agent:main:discord:channel:1475079601968648386',
  });
});

test('buildSessionContextPrompt resolves connected channels from live registry state', async () => {
  const {
    buildSessionContext,
    buildSessionContextPrompt,
    DISCORD_CAPABILITIES,
    TUI_CAPABILITIES,
    registerChannel,
  } = await importFreshSessionContextModules();

  const context = buildSessionContext({
    source: {
      channelKind: 'discord',
      chatId: '1475079601968648386',
      chatType: 'channel',
    },
    agentId: 'main',
    sessionId: 'sess_20260317_114200_abcdef01',
  });

  expect(buildSessionContextPrompt(context)).toContain(
    '**Connected channels:** none',
  );

  registerChannel({
    kind: 'discord',
    id: 'discord-bot',
    capabilities: DISCORD_CAPABILITIES,
  });
  registerChannel({
    kind: 'tui',
    id: 'tui',
    capabilities: TUI_CAPABILITIES,
  });

  expect(buildSessionContextPrompt(context)).toContain(
    '**Connected channels:** discord, tui',
  );
});

test('buildSessionContextPrompt canonicalizes Teams labels', async () => {
  const {
    buildSessionContext,
    buildSessionContextPrompt,
    MSTEAMS_CAPABILITIES,
    registerChannel,
  } = await importFreshSessionContextModules();

  registerChannel({
    kind: 'msteams',
    id: 'msteams',
    capabilities: MSTEAMS_CAPABILITIES,
  });

  const context = buildSessionContext({
    source: {
      channelKind: 'teams',
      chatId: 'teams:thread',
      chatType: 'group',
    },
    agentId: 'main',
    sessionId: 'sess_20260317_114200_abcdef01',
  });

  expect(context.source.channelKind).toBe('teams');
  expect(buildSessionContextPrompt(context)).toContain(
    '**Platform:** Microsoft Teams (group chat)',
  );
  expect(buildSessionContextPrompt(context)).toContain(
    '**Connected channels:** msteams',
  );
});

test('buildSessionContext keeps missing channel kinds undefined until prompt render time', async () => {
  const { buildSessionContext, buildSessionContextPrompt } =
    await importFreshSessionContextModules();

  const context = buildSessionContext({
    source: {
      chatId: 'local-session',
      chatType: 'system',
    },
    agentId: 'main',
    sessionId: 'sess_20260317_114200_deadbeef',
  });

  expect(context.source.channelKind).toBeUndefined();
  expect(buildSessionContextPrompt(context)).toContain(
    '**Platform:** Unknown (system)',
  );
  expect(buildSessionContextPrompt(context)).toContain(
    '**Connected channels:** none',
  );
});

test('buildSessionContextPrompt renders Discord context details', async () => {
  const {
    buildSessionContext,
    buildSessionContextPrompt,
    DISCORD_CAPABILITIES,
    TUI_CAPABILITIES,
    registerChannel,
  } = await importFreshSessionContextModules();

  registerChannel({
    kind: 'discord',
    id: 'discord-bot',
    capabilities: DISCORD_CAPABILITIES,
  });
  registerChannel({
    kind: 'tui',
    id: 'tui',
    capabilities: TUI_CAPABILITIES,
  });

  const prompt = buildSessionContextPrompt(
    buildSessionContext({
      source: {
        channelKind: 'discord',
        chatId: '1475079601968648386',
        chatType: 'channel',
        userId: '123456',
        userName: 'alice',
        guildId: '987654',
        guildName: 'Ops',
      },
      agentId: 'main',
      sessionId: 'sess_20260316_185427_1a2b3c4d',
      sessionKey: 'agent:main:discord:channel:1475079601968648386',
    }),
  );

  expect(prompt).toContain('## Session Context');
  expect(prompt).toContain('**Platform:** Discord (channel)');
  expect(prompt).toContain('**Session:** sess_20260316_185427_1a2b3c4d');
  expect(prompt).toContain(
    '**Session key:** agent:main:discord:channel:1475079601968648386',
  );
  expect(prompt).toContain('**User:** alice (id: 123456)');
  expect(prompt).toContain('**Guild:** Ops (id: 987654)');
  expect(prompt).toContain('**Connected channels:** discord, tui');
});

test('buildSessionContextPrompt renders TUI and heartbeat sources', async () => {
  const {
    buildSessionContext,
    buildSessionContextPrompt,
    SYSTEM_CAPABILITIES,
    TUI_CAPABILITIES,
    registerChannel,
  } = await importFreshSessionContextModules();

  registerChannel({
    kind: 'heartbeat',
    id: 'heartbeat',
    capabilities: SYSTEM_CAPABILITIES,
  });
  registerChannel({
    kind: 'tui',
    id: 'tui',
    capabilities: TUI_CAPABILITIES,
  });

  const tuiPrompt = buildSessionContextPrompt(
    buildSessionContext({
      source: {
        channelKind: 'tui',
        chatId: 'tui',
        chatType: 'dm',
        userId: 'tui-user',
      },
      agentId: 'main',
      sessionId: '20260316_122238_532f05',
      sessionKey: 'agent:main:tui:dm:local',
    }),
  );
  const heartbeatPrompt = buildSessionContextPrompt(
    buildSessionContext({
      source: {
        channelKind: 'heartbeat',
        chatId: 'heartbeat',
        chatType: 'system',
      },
      agentId: 'main',
      sessionId: 'sess_20260316_185427_deadbeef',
      sessionKey: 'agent:main:heartbeat:system:default',
    }),
  );

  expect(tuiPrompt).toContain('**Platform:** TUI (direct message)');
  expect(tuiPrompt).toContain('**Session:** 20260316_122238_532f05');
  expect(tuiPrompt).toContain('**Session key:** agent:main:tui:dm:local');
  expect(heartbeatPrompt).toContain('**Platform:** Heartbeat (system)');
  expect(heartbeatPrompt).toContain(
    '**Session:** sess_20260316_185427_deadbeef',
  );
  expect(heartbeatPrompt).toContain('**Connected channels:** heartbeat, tui');
});

test('buildSessionContextPrompt renders scheduler cron sources as scheduled runs', async () => {
  const {
    buildSessionContext,
    buildSessionContextPrompt,
    SYSTEM_CAPABILITIES,
    registerChannel,
  } = await importFreshSessionContextModules();

  registerChannel({
    kind: 'scheduler',
    id: 'scheduler',
    capabilities: SYSTEM_CAPABILITIES,
  });

  const prompt = buildSessionContextPrompt(
    buildSessionContext({
      source: {
        channelKind: 'scheduler',
        chatId: 'scheduler',
        chatType: 'cron',
        userId: 'scheduler',
        userName: 'scheduler',
      },
      agentId: 'main',
      sessionId: 'agent:main:scheduler:cron:42',
      sessionKey: 'agent:main:scheduler:cron:42',
    }),
  );

  expect(prompt).toContain('**Platform:** Scheduler (scheduled run)');
  expect(prompt).toContain('**User:** scheduler (id: scheduler)');
  expect(prompt).toContain('**Connected channels:** scheduler');
});

test('buildSessionContextPrompt falls back to unknown channel labels', async () => {
  const { buildSessionContext, buildSessionContextPrompt } =
    await importFreshSessionContextModules();

  const prompt = buildSessionContextPrompt(
    buildSessionContext({
      source: {
        channelKind: 'irc',
        chatId: '#ops',
        chatType: 'channel',
      },
      agentId: 'main',
      sessionId: 'sess_20260317_114200_feedface',
    }),
  );

  expect(prompt).toContain('**Platform:** irc (channel)');
  expect(prompt).toContain('**Connected channels:** none');
});

test('prompt hooks include session context when runtime info provides it', async () => {
  vi.resetModules();
  const { DISCORD_CAPABILITIES } = await import('../src/channels/channel.js');
  const { registerChannel } = await import('../src/channels/channel-registry.js');
  const { buildSessionContext } = await import('../src/session/session-context.js');
  const { buildSystemPromptFromHooks } = await import(
    '../src/agent/prompt-hooks.js'
  );

  registerChannel({
    kind: 'discord',
    id: 'discord-bot',
    capabilities: DISCORD_CAPABILITIES,
  });

  const sessionContext = buildSessionContext({
    source: {
      channelKind: 'discord',
      chatId: '1475079601968648386',
      chatType: 'channel',
      userId: '123456',
      userName: 'alice',
      guildId: '987654',
    },
    agentId: 'main',
    sessionId: 'sess_20260316_185427_1a2b3c4d',
    sessionKey: 'agent:main:discord:channel:1475079601968648386',
  });

  const prompt = buildSystemPromptFromHooks({
    agentId: 'main',
    sessionSummary: 'Earlier context',
    skills: [],
    runtimeInfo: {
      sessionContext,
    },
  });

  expect(prompt).toContain('## Session Summary');
  expect(prompt).toContain('## Session Context');
  expect(prompt).toContain('**Connected channels:** discord');
  expect(prompt.indexOf('## Session Summary')).toBeLessThan(
    prompt.indexOf('## Session Context'),
  );
});
