export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function buildVoiceSessionKey(agentId, callUuid) {
  return [
    'agent',
    encodeURIComponent(agentId),
    'channel',
    'voice',
    'chat',
    'dm',
    'peer',
    encodeURIComponent(callUuid),
  ].join(':');
}
