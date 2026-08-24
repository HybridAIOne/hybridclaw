const SESSION_KEY_MARKERS = new Set([
  'agent',
  'channel',
  'chat',
  'peer',
  'thread',
  'topic',
  'subagent',
]);

function normalizeSessionKeySegment(value, label) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) {
    throw new Error(`Session key ${label} cannot be empty`);
  }
  return normalized;
}

function encodeSessionKeySegment(value, label) {
  return encodeURIComponent(normalizeSessionKeySegment(value, label));
}

function decodeSessionKeySegment(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  try {
    return decodeURIComponent(normalized);
  } catch {
    return '';
  }
}

export function buildSessionKey(
  agentId,
  channelKind,
  chatType,
  peerId,
  options,
) {
  const parts = [
    'agent',
    encodeSessionKeySegment(agentId, 'agentId'),
    'channel',
    encodeSessionKeySegment(channelKind, 'channelKind'),
    'chat',
    encodeSessionKeySegment(chatType, 'chatType'),
    'peer',
    encodeSessionKeySegment(peerId, 'peerId'),
  ];

  if (options?.threadId) {
    parts.push('thread', encodeSessionKeySegment(options.threadId, 'threadId'));
  }
  if (options?.topicId) {
    parts.push('topic', encodeSessionKeySegment(options.topicId, 'topicId'));
  }
  if (options?.subagentId) {
    parts.push(
      'subagent',
      encodeSessionKeySegment(options.subagentId, 'subagentId'),
    );
  }

  return parts.join(':');
}

function parseTypedSessionKey(parts) {
  if (parts.length < 8 || parts[0] !== 'agent') return null;

  const values = new Map();
  for (let index = 0; index < parts.length; index += 2) {
    const marker = parts[index];
    const rawValue = parts[index + 1];
    if (!SESSION_KEY_MARKERS.has(marker) || rawValue === undefined) {
      return null;
    }
    if (values.has(marker)) return null;
    const decoded = decodeSessionKeySegment(rawValue);
    if (!decoded) return null;
    values.set(marker, decoded);
  }

  const agentId = values.get('agent');
  const channelKind = values.get('channel');
  const chatType = values.get('chat');
  const peerId = values.get('peer');
  if (!agentId || !channelKind || !chatType || !peerId) return null;

  return {
    agentId,
    channelKind,
    chatType,
    peerId,
    ...(values.get('thread') ? { threadId: values.get('thread') } : {}),
    ...(values.get('topic') ? { topicId: values.get('topic') } : {}),
    ...(values.get('subagent') ? { subagentId: values.get('subagent') } : {}),
  };
}

export function parseSessionKey(key) {
  const parts = String(key || '')
    .trim()
    .split(':');
  if (parts.length < 5) return null;
  if (parts[0] !== 'agent') return null;
  if (parts[2] === 'channel') {
    return parseTypedSessionKey(parts);
  }

  // Keep positional canonical keys readable for pre-typed rows and exports.
  const [_, agentId, channelKind, chatType, ...peerParts] = parts;
  const peerId = peerParts.join(':').trim();
  if (!agentId || !channelKind || !chatType || !peerId) return null;
  return { agentId, channelKind, chatType, peerId };
}
