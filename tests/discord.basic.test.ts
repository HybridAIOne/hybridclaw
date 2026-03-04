import { expect, test } from 'vitest';

import { buildResponseText } from '../src/channels/discord/delivery.js';
import { isTrigger, parseCommand } from '../src/channels/discord/inbound.js';
import { rewriteUserMentions, type MentionLookup } from '../src/channels/discord/mentions.js';

function createLookup(entries: Record<string, string[]>): MentionLookup {
  const byAlias = new Map<string, Set<string>>();
  for (const [alias, ids] of Object.entries(entries)) {
    byAlias.set(alias, new Set(ids));
  }
  return { byAlias };
}

test('rewriteUserMentions rewrites a uniquely-resolved @alias', () => {
  const lookup = createLookup({ alice: ['123456789012345678'] });
  const output = rewriteUserMentions('Ping @alice please.', lookup);
  expect(output).toBe('Ping <@123456789012345678> please.');
});

test('rewriteUserMentions does not rewrite ambiguous aliases', () => {
  const lookup = createLookup({ bob: ['111111111111111111', '222222222222222222'] });
  const output = rewriteUserMentions('hi @bob', lookup);
  expect(output).toBe('hi @bob');
});

test('rewriteUserMentions keeps @everyone and @here untouched', () => {
  const lookup = createLookup({
    everyone: ['333333333333333333'],
    here: ['444444444444444444'],
  });
  const output = rewriteUserMentions('notify @everyone and @here', lookup);
  expect(output).toBe('notify @everyone and @here');
});

test('buildResponseText appends tool footer when tools were used', () => {
  const output = buildResponseText('Done.', ['vision_analyze', 'message']);
  expect(output).toBe('Done.\n*Tools: vision_analyze, message*');
});

test('buildResponseText leaves text unchanged when no tools were used', () => {
  const output = buildResponseText('Done.');
  expect(output).toBe('Done.');
});

test('isTrigger blocks non-command chatter when channel mode is off', () => {
  const shouldTrigger = isTrigger({
    content: 'hello',
    isDm: false,
    commandsOnly: false,
    respondToAllMessages: false,
    guildMessageMode: 'off',
    prefix: '!claw',
    botMentionRegex: null,
    hasBotMention: false,
  });
  expect(shouldTrigger).toBe(false);
});

test('isTrigger still allows prefixed commands when channel mode is off', () => {
  const shouldTrigger = isTrigger({
    content: '!claw status',
    isDm: false,
    commandsOnly: false,
    respondToAllMessages: false,
    guildMessageMode: 'off',
    prefix: '!claw',
    botMentionRegex: null,
    hasBotMention: false,
  });
  expect(shouldTrigger).toBe(true);
});

test('isTrigger allows free-response mode in guild channels', () => {
  const shouldTrigger = isTrigger({
    content: 'hello',
    isDm: false,
    commandsOnly: false,
    respondToAllMessages: false,
    guildMessageMode: 'free',
    prefix: '!claw',
    botMentionRegex: null,
    hasBotMention: false,
  });
  expect(shouldTrigger).toBe(true);
});

test('parseCommand recognizes channel command namespace', () => {
  const parsed = parseCommand('!claw channel mode free', null, '!claw');
  expect(parsed).toEqual({
    isCommand: true,
    command: 'channel',
    args: ['mode', 'free'],
  });
});
