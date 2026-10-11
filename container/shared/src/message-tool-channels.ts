export const MESSAGE_TOOL_CHANNEL_KINDS = [
  'discord',
  'discord_webhook',
  'email',
  'imessage',
  'line',
  'msteams',
  'signal',
  'slack',
  'slack_webhook',
  'telegram',
  'threema',
  'tui',
  'whatsapp',
] as const;

export type MessageToolChannelKind =
  (typeof MESSAGE_TOOL_CHANNEL_KINDS)[number];

export const MESSAGE_TOOL_CHANNEL_LABELS: Readonly<
  Record<MessageToolChannelKind, string>
> = Object.freeze({
  discord: 'Discord',
  discord_webhook: 'Discord webhook',
  email: 'email',
  imessage: 'iMessage',
  line: 'LINE self-chat',
  msteams: 'Microsoft Teams',
  signal: 'Signal',
  slack: 'Slack',
  slack_webhook: 'Slack webhook',
  telegram: 'Telegram',
  threema: 'Threema',
  tui: 'local TUI',
  whatsapp: 'WhatsApp',
});

const MESSAGE_TOOL_CHANNEL_KIND_SET = new Set<string>(
  MESSAGE_TOOL_CHANNEL_KINDS,
);

export function isMessageToolChannelKind(
  kind: string,
): kind is MessageToolChannelKind {
  return MESSAGE_TOOL_CHANNEL_KIND_SET.has(String(kind || '').toLowerCase());
}

export function normalizeMessageToolChannelKinds(
  kinds: readonly string[] | undefined,
): MessageToolChannelKind[] {
  if (!Array.isArray(kinds)) return [];
  const normalized = new Set<MessageToolChannelKind>();
  for (const kind of kinds) {
    const candidate = String(kind || '')
      .trim()
      .toLowerCase();
    if (isMessageToolChannelKind(candidate)) normalized.add(candidate);
  }
  return [...normalized].sort();
}

export function formatMessageToolChannelList(
  kinds: readonly string[] | undefined,
): string {
  const labels = normalizeMessageToolChannelKinds(kinds).map(
    (kind) => MESSAGE_TOOL_CHANNEL_LABELS[kind],
  );
  if (labels.length === 0) return 'none';
  return labels.join(', ');
}
