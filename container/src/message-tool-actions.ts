/**
 * Message tool action aliases: maps the words models use for an action
 * (`reply`, `history`, `whois`, …) to the canonical action the gateway accepts.
 *
 * An unknown word maps to null and the tool refuses it before any request is
 * sent. NOT the action list or the request shape; both are the wire contract
 * in `@hybridclaw/contracts/message-action`, and the gateway accepts only
 * canonical actions.
 */
import type { MessageToolAction } from '@hybridclaw/contracts/message-action';

const MESSAGE_TOOL_ACTION_ALIASES: Readonly<Record<string, MessageToolAction>> =
  Object.freeze({
    read: 'read',
    readmessages: 'read',
    history: 'read',
    fetch: 'read',
    memberinfo: 'member-info',
    lookup: 'member-info',
    whois: 'member-info',
    channelinfo: 'channel-info',
    react: 'react',
    reaction: 'react',
    reactions: 'react',
    quotereply: 'quote-reply',
    replymessage: 'quote-reply',
    replyto: 'quote-reply',
    edit: 'edit',
    update: 'edit',
    delete: 'delete',
    remove: 'delete',
    pin: 'pin',
    unpin: 'unpin',
    threadcreate: 'thread-create',
    createthread: 'thread-create',
    threadreply: 'thread-reply',
    replythread: 'thread-reply',
    send: 'send',
    sendmessage: 'send',
    dm: 'send',
    post: 'send',
    reply: 'send',
    respond: 'send',
  });

export function normalizeMessageToolAction(
  rawAction: unknown,
): MessageToolAction | null {
  if (typeof rawAction !== 'string') return null;
  const compact = rawAction
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  return Object.hasOwn(MESSAGE_TOOL_ACTION_ALIASES, compact)
    ? MESSAGE_TOOL_ACTION_ALIASES[compact]
    : null;
}
