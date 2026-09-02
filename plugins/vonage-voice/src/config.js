const E164_RE = /^\+[1-9]\d{7,14}$/;

export function resolveConfig(api) {
  const config = api.pluginConfig;
  const applicationId = String(config.applicationId || '').trim();
  const fromNumber = String(config.fromNumber || '').trim();
  let publicBaseUrl = String(config.publicBaseUrl || '').trim();
  while (publicBaseUrl.endsWith('/')) {
    publicBaseUrl = publicBaseUrl.slice(0, -1);
  }
  const privateKey = String(
    api.getCredential('VONAGE_PRIVATE_KEY') || '',
  ).trim();
  const signatureSecret = String(
    api.getCredential('VONAGE_SIGNATURE_SECRET') || '',
  ).trim();
  if (!applicationId) throw new Error('Vonage applicationId is required.');
  if (!E164_RE.test(fromNumber)) {
    throw new Error('Vonage fromNumber must be an E.164 number.');
  }
  if (!/^https:\/\//i.test(publicBaseUrl)) {
    throw new Error('Vonage publicBaseUrl must be a public HTTPS URL.');
  }
  if (!privateKey) throw new Error('VONAGE_PRIVATE_KEY is required.');
  if (!signatureSecret) throw new Error('VONAGE_SIGNATURE_SECRET is required.');
  // Caller gating, the turn-mode greeting, language, and barge-in are
  // properties of the phone channel rather than of this transport, so they
  // come from the core voice config the same way speech.realtime.* does.
  const voice = api.config?.voice || {};
  const relay = voice.relay || {};
  const callerPolicy =
    typeof voice.callerPolicy === 'string' ? voice.callerPolicy : 'open';
  const allowFrom = Array.isArray(voice.allowFrom)
    ? voice.allowFrom.map((value) => String(value))
    : [];
  const mode = String(config.mode || 'turn').trim() || 'turn';
  if (mode !== 'turn' && mode !== 'realtime') {
    throw new Error('Vonage mode must be "turn" or "realtime".');
  }
  return {
    applicationId,
    fromNumber,
    publicBaseUrl,
    privateKey,
    signatureSecret,
    callerPolicy,
    allowFrom,
    mode,
    language: String(relay.language || 'en-US').trim() || 'en-US',
    welcomeGreeting:
      String(relay.welcomeGreeting || '').trim() ||
      'Hello! How can I help you today?',
    interruptible: relay.interruptible !== false,
    maxConcurrentCalls: Number(config.maxConcurrentCalls || 8),
  };
}

export function normalizePhoneNumber(value) {
  const normalized = String(value || '').replace(/[\s().-]/g, '');
  return E164_RE.test(normalized) ? normalized : '';
}
