export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

export function buildVoiceSessionKey(agentId, callUuid) {
  return [
    'agent',
    segment(agentId),
    'channel',
    'voice',
    'chat',
    'dm',
    'peer',
    segment(callUuid),
  ].join(':');
}
