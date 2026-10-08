export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function rawDataToString(raw) {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

export function buildVoiceSessionKey(agentId, callSid) {
  return [
    'agent',
    encodeURIComponent(agentId),
    'channel',
    'voice',
    'chat',
    'dm',
    'peer',
    encodeURIComponent(callSid),
  ].join(':');
}
