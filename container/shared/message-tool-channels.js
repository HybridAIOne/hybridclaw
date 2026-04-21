export const MESSAGE_TOOL_CHANNEL_KINDS = [
  'discord',
  'email',
  'imessage',
  'msteams',
  'slack',
  'telegram',
  'tui',
  'whatsapp',
];

export const MESSAGE_TOOL_CHANNEL_LABELS = Object.freeze({
  discord: 'Discord',
  email: 'email',
  imessage: 'iMessage',
  msteams: 'Microsoft Teams',
  slack: 'Slack',
  telegram: 'Telegram',
  tui: 'local TUI',
  whatsapp: 'WhatsApp',
});

const MESSAGE_TOOL_CHANNEL_KIND_SET = new Set(MESSAGE_TOOL_CHANNEL_KINDS);

export function isMessageToolChannelKind(kind) {
  return MESSAGE_TOOL_CHANNEL_KIND_SET.has(String(kind || '').toLowerCase());
}

export function normalizeMessageToolChannelKinds(kinds) {
  if (!Array.isArray(kinds)) return [];
  const normalized = new Set();
  for (const kind of kinds) {
    const candidate = String(kind || '')
      .trim()
      .toLowerCase();
    if (isMessageToolChannelKind(candidate)) normalized.add(candidate);
  }
  return [...normalized].sort();
}

export function formatMessageToolChannelList(kinds) {
  const labels = normalizeMessageToolChannelKinds(kinds).map(
    (kind) => MESSAGE_TOOL_CHANNEL_LABELS[kind],
  );
  if (labels.length === 0) return 'none';
  return labels.join(', ');
}
