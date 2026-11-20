/**
 * Message action request — what the agent's `message` tool POSTs to the
 * gateway's `/api/message/action` route, and the one list of actions it names.
 *
 * The gateway checks every request against `MessageActionRequestSchema` and
 * rejects a malformed one whole; it never drops a field it cannot read. NOT
 * the model-facing alias handling (`container/src/message-tool-actions.ts`):
 * aliases such as `reply` are resolved in the agent, so only canonical
 * actions cross the wire. Whether an action needs approval is the agent's
 * approval policy, not this module.
 */
import {
  array,
  boolean,
  type Infer,
  literal,
  nullable,
  number,
  object,
  optional,
  string,
  unchecked,
} from './schema.ts';

export const MESSAGE_TOOL_ACTIONS = [
  'read',
  'member-info',
  'channel-info',
  'send',
  'react',
  'quote-reply',
  'edit',
  'delete',
  'pin',
  'unpin',
  'thread-create',
  'thread-reply',
] as const;

export type MessageToolAction = (typeof MESSAGE_TOOL_ACTIONS)[number];

export const MessageActionRequestSchema = object({
  action: literal(...MESSAGE_TOOL_ACTIONS),
  sessionId: optional(string()),
  channelId: optional(string()),
  contextChannelId: optional(string()),
  guildId: optional(string()),
  userId: optional(string()),
  memberId: optional(string()),
  username: optional(string()),
  user: optional(string()),
  resolveAmbiguous: optional(literal('error', 'best')),
  // Read: chat history window and mailbox search.
  limit: optional(number()),
  before: optional(string()),
  after: optional(string()),
  around: optional(string()),
  query: optional(string()),
  folder: optional(string()),
  folders: optional(array(string())),
  uid: optional(number()),
  unreadOnly: optional(boolean()),
  // A mailbox read filter. Plugin-channel sends refuse any value, null
  // included, so the agent forwards it exactly as the model gave it.
  from: optional(nullable(string())),
  since: optional(string()),
  beforeDate: optional(string()),
  // Send and reply.
  content: optional(string()),
  subject: optional(string()),
  cc: optional(array(string())),
  bcc: optional(array(string())),
  inReplyTo: optional(string()),
  references: optional(array(string())),
  filePath: optional(string()),
  // Discord message components; the Discord runtime checks their shape.
  components: optional(unchecked<unknown>()),
  messageId: optional(string()),
  emoji: optional(string()),
  name: optional(string()),
  autoArchiveDuration: optional(number()),
});

export type MessageActionRequest = Infer<typeof MessageActionRequestSchema>;
