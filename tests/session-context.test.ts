import { expect, test } from 'vitest';

import { buildSystemPromptFromHooks } from '../src/agent/prompt-hooks.js';
import {
  buildSessionContext,
  buildSessionContextPrompt,
} from '../src/session/session-context.js';

test('buildSessionContext assembles normalized session fields', () => {
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
    connectedChannels: ['discord', ' tui ', 'discord'],
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
    connectedChannels: ['discord', 'tui'],
  });
});

test('buildSessionContext includes the active source channel in connected channels', () => {
  const context = buildSessionContext({
    source: {
      channelKind: 'tui',
      chatId: 'tui',
      chatType: 'dm',
      userId: 'tui-user',
    },
    agentId: 'main',
    sessionId: '20260316_122238_532f05',
    sessionKey: 'agent:main:tui:dm:local',
    connectedChannels: ['discord', 'email'],
  });

  expect(context.connectedChannels).toEqual(['tui', 'discord', 'email']);
});

test('buildSessionContextPrompt renders Discord context details', () => {
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
      connectedChannels: ['discord', 'tui'],
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

test('buildSessionContextPrompt renders TUI and heartbeat sources', () => {
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
      connectedChannels: ['tui'],
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
      connectedChannels: ['heartbeat'],
    }),
  );

  expect(tuiPrompt).toContain('**Platform:** TUI (direct message)');
  expect(tuiPrompt).toContain('**Session:** 20260316_122238_532f05');
  expect(tuiPrompt).toContain('**Session key:** agent:main:tui:dm:local');
  expect(heartbeatPrompt).toContain('**Platform:** Heartbeat (system)');
  expect(heartbeatPrompt).toContain('**Session:** sess_20260316_185427_deadbeef');
  expect(heartbeatPrompt).toContain('**Connected channels:** heartbeat');
});

test('prompt hooks include session context when runtime info provides it', () => {
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
    connectedChannels: ['discord'],
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
  expect(prompt.indexOf('## Session Summary')).toBeLessThan(
    prompt.indexOf('## Session Context'),
  );
});
