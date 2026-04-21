export declare const MESSAGE_TOOL_CHANNEL_KINDS: readonly [
  'discord',
  'email',
  'imessage',
  'msteams',
  'slack',
  'telegram',
  'tui',
  'whatsapp',
];

export type MessageToolChannelKind =
  (typeof MESSAGE_TOOL_CHANNEL_KINDS)[number];

export declare const MESSAGE_TOOL_CHANNEL_LABELS: Readonly<
  Record<MessageToolChannelKind, string>
>;

export declare function isMessageToolChannelKind(
  kind: string,
): kind is MessageToolChannelKind;

export declare function normalizeMessageToolChannelKinds(
  kinds: readonly string[] | undefined,
): MessageToolChannelKind[];

export declare function formatMessageToolChannelList(
  kinds: readonly string[] | undefined,
): string;
