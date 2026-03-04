import { expect, test } from 'vitest';

import { buildResponseText } from '../src/channels/discord/delivery.js';
import {
  hasLooseBotMention,
  isAddressedToChannel,
  isAuthorizedCommandUser,
  isTrigger,
  parseCommand,
  shouldReplyInFreeMode,
  shouldSkipFreeReplyBecauseOtherUsersMentioned,
} from '../src/channels/discord/inbound.js';
import {
  type MentionLookup,
  rewriteUserMentions,
} from '../src/channels/discord/mentions.js';

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
  const lookup = createLookup({
    bob: ['111111111111111111', '222222222222222222'],
  });
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

test('isTrigger allows slash-text commands when channel mode is off', () => {
  const shouldTrigger = isTrigger({
    content: '/status',
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
    content: 'Can you review this patch?',
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

test('isTrigger keeps mention mode even when respondToAllMessages is enabled', () => {
  const shouldTrigger = isTrigger({
    content: 'hello',
    isDm: false,
    commandsOnly: false,
    respondToAllMessages: true,
    guildMessageMode: 'mention',
    prefix: '!claw',
    botMentionRegex: null,
    hasBotMention: false,
  });
  expect(shouldTrigger).toBe(false);
});

test('parseCommand recognizes channel command namespace', () => {
  const parsed = parseCommand('!claw channel mode free', null, '!claw');
  expect(parsed).toEqual({
    isCommand: true,
    command: 'channel',
    args: ['mode', 'free'],
  });
});

test('parseCommand recognizes usage command namespace', () => {
  const parsed = parseCommand('!claw usage monthly', null, '!claw');
  expect(parsed).toEqual({
    isCommand: true,
    command: 'usage',
    args: ['monthly'],
  });
});

test('parseCommand recognizes status command namespace', () => {
  const parsed = parseCommand('!claw status', null, '!claw');
  expect(parsed).toEqual({
    isCommand: true,
    command: 'status',
    args: [],
  });
});

test('parseCommand recognizes slash-text status command namespace', () => {
  const parsed = parseCommand('/status', null, '!claw');
  expect(parsed).toEqual({
    isCommand: true,
    command: 'status',
    args: [],
  });
});

test('isTrigger commands-only allows slash-text commands', () => {
  const shouldTrigger = isTrigger({
    content: '/status',
    isDm: false,
    commandsOnly: true,
    respondToAllMessages: false,
    guildMessageMode: 'off',
    prefix: '!claw',
    botMentionRegex: null,
    hasBotMention: false,
  });
  expect(shouldTrigger).toBe(true);
});

test('free-mode skips non-bot user mentions', () => {
  const shouldSkip = shouldSkipFreeReplyBecauseOtherUsersMentioned({
    guildMessageMode: 'free',
    hasBotMention: false,
    hasPrefixInvocation: false,
    botUserId: '111',
    mentionedUserIds: ['222'],
  });
  expect(shouldSkip).toBe(true);
});

test('free-mode does not skip when bot is mentioned', () => {
  const shouldSkip = shouldSkipFreeReplyBecauseOtherUsersMentioned({
    guildMessageMode: 'free',
    hasBotMention: true,
    hasPrefixInvocation: false,
    botUserId: '111',
    mentionedUserIds: ['111', '222'],
  });
  expect(shouldSkip).toBe(false);
});

test('free-mode replies to actionable questions', () => {
  const shouldReply = shouldReplyInFreeMode({
    guildMessageMode: 'free',
    content: 'Can you review this patch?',
    hasBotMention: false,
    hasPrefixInvocation: false,
    isReplyToBot: false,
    hasAttachments: false,
  });
  expect(shouldReply).toBe(true);
});

test('free-mode replies to plain-text bot-name mentions', () => {
  const hasLooseMention = hasLooseBotMention('hybridclaw, thoughts on this?', [
    'HybridClaw',
    'claw',
  ]);
  expect(hasLooseMention).toBe(true);

  const shouldReply = shouldReplyInFreeMode({
    guildMessageMode: 'free',
    content: 'hybridclaw please take a look',
    hasBotMention: false,
    hasLooseBotMention: true,
    hasPrefixInvocation: false,
    isReplyToBot: false,
    hasAttachments: false,
  });
  expect(shouldReply).toBe(true);
});

test('free-mode replies to channel-addressed messages', () => {
  expect(isAddressedToChannel('Hey everyone, quick status update')).toBe(true);

  const shouldReply = shouldReplyInFreeMode({
    guildMessageMode: 'free',
    content: 'Hey everyone, quick status update',
    hasBotMention: false,
    hasPrefixInvocation: false,
    isAddressedToChannel: true,
    isReplyToBot: false,
    hasAttachments: false,
  });
  expect(shouldReply).toBe(true);
});

test('free-mode ignores low-signal acknowledgements', () => {
  const shouldReply = shouldReplyInFreeMode({
    guildMessageMode: 'free',
    content: 'ok',
    hasBotMention: false,
    hasPrefixInvocation: false,
    isReplyToBot: false,
    hasAttachments: false,
  });
  expect(shouldReply).toBe(false);
});

test('free-mode allows reply-to-bot followups', () => {
  const shouldReply = shouldReplyInFreeMode({
    guildMessageMode: 'free',
    content: 'sure',
    hasBotMention: false,
    hasPrefixInvocation: false,
    isReplyToBot: true,
    hasAttachments: false,
  });
  expect(shouldReply).toBe(true);
});

test('command access allows all users in public mode', () => {
  const authorized = isAuthorizedCommandUser({
    mode: 'public',
    userId: '222',
    allowedUserIds: ['111'],
    legacyCommandUserId: '333',
  });
  expect(authorized).toBe(true);
});

test('command access enforces allowlist in restricted mode', () => {
  const authorized = isAuthorizedCommandUser({
    mode: 'restricted',
    userId: '222',
    allowedUserIds: ['111', '222'],
  });
  expect(authorized).toBe(true);
  const denied = isAuthorizedCommandUser({
    mode: 'restricted',
    userId: '333',
    allowedUserIds: ['111', '222'],
  });
  expect(denied).toBe(false);
});

test('command access uses legacy commandUserId in restricted mode', () => {
  const authorized = isAuthorizedCommandUser({
    mode: 'restricted',
    userId: '777',
    allowedUserIds: [],
    legacyCommandUserId: '777',
  });
  expect(authorized).toBe(true);
});
