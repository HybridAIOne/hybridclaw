export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function rawDataToString(raw) {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

// Mirrors core buildSessionKey (container/shared/session-keys.js), which
// trims and lowercases each segment; tests/voice-plugin-session-keys.test.ts
// fails when the two diverge.
const segment = (value) =>
  encodeURIComponent(
    String(value || '')
      .trim()
      .toLowerCase(),
  );

export function buildVoiceSessionKey(agentId, callSid) {
  return [
    'agent',
    segment(agentId),
    'channel',
    'voice',
    'chat',
    'dm',
    'peer',
    segment(callSid),
  ].join(':');
}
