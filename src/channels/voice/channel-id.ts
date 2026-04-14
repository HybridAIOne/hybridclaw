const VOICE_CHANNEL_PREFIX = 'voice:';

export function buildVoiceChannelId(callSid: string): string {
  const normalized = String(callSid || '').trim();
  if (!normalized) {
    throw new Error('Voice call SID is required.');
  }
  return `${VOICE_CHANNEL_PREFIX}${normalized}`;
}

export function isVoiceChannelId(value?: string | null): boolean {
  const normalized = String(value || '').trim();
  return normalized.startsWith(VOICE_CHANNEL_PREFIX);
}

export function parseVoiceChannelId(value?: string | null): string | null {
  if (!isVoiceChannelId(value)) {
    return null;
  }
  const callSid = String(value || '')
    .trim()
    .slice(VOICE_CHANNEL_PREFIX.length)
    .trim();
  return callSid || null;
}
