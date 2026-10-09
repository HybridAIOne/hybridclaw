/**
 * TwiML responses and Twilio's form-encoded webhook bodies.
 *
 * Every attribute value is XML-escaped; relay attributes come from the core
 * `voice.relay.*` settings. Bodies over 256 KiB are refused rather than
 * buffered, since the webhook is reachable before signature checks run.
 */

const MAX_FORM_BODY_BYTES = 256 * 1024;
const XML_PROLOG = '<?xml version="1.0" encoding="UTF-8"?>';

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function xmlAttributes(attributes) {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => ` ${name}="${escapeXml(String(value))}"`)
    .join('');
}

function parameterXml(customParameters) {
  return Object.entries(customParameters || {})
    .map(([name, value]) => `<Parameter${xmlAttributes({ name, value })} />`)
    .join('');
}

function interruptibleMode(value) {
  return value ? 'any' : 'none';
}

const TTS_PROVIDERS = {
  default: undefined,
  google: 'Google',
  amazon: 'Amazon',
};
const TRANSCRIPTION_PROVIDERS = {
  default: undefined,
  google: 'Google',
  deepgram: 'Deepgram',
};

function lookupProvider(table, value, setting) {
  if (!Object.hasOwn(table, value)) {
    throw new Error(`Unsupported ${setting}: ${String(value)}`);
  }
  return table[value];
}

/** Null when the body is too large to be a Twilio webhook. */
export async function readTwilioFormBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_FORM_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  const body = {};
  for (const [key, value] of new URLSearchParams(
    Buffer.concat(chunks).toString('utf8'),
  )) {
    body[key] = value;
  }
  return body;
}

export function buildConversationRelayTwiml({
  websocketUrl,
  actionUrl,
  relay,
  customParameters,
}) {
  const relayAttributes = xmlAttributes({
    url: websocketUrl,
    welcomeGreeting: relay.welcomeGreeting,
    welcomeGreetingInterruptible: interruptibleMode(relay.interruptible),
    language: relay.language,
    ttsProvider: lookupProvider(
      TTS_PROVIDERS,
      relay.ttsProvider,
      'voice.relay.ttsProvider',
    ),
    voice: relay.voice || undefined,
    transcriptionProvider: lookupProvider(
      TRANSCRIPTION_PROVIDERS,
      relay.transcriptionProvider,
      'voice.relay.transcriptionProvider',
    ),
    interruptible: interruptibleMode(relay.interruptible),
    // Intentional Twilio defaults for the current voice UX: do not transcribe
    // over active agent speech, and do not preempt the current spoken turn.
    reportInputDuringAgentSpeech: 'none',
    preemptible: 'false',
  });
  return (
    `${XML_PROLOG}<Response><Connect${xmlAttributes({ action: actionUrl })}>` +
    `<ConversationRelay${relayAttributes}>${parameterXml(customParameters)}</ConversationRelay>` +
    '</Connect></Response>'
  );
}

export function buildMediaStreamTwiml({
  websocketUrl,
  actionUrl,
  customParameters,
}) {
  return (
    `${XML_PROLOG}<Response><Connect${xmlAttributes({ action: actionUrl })}>` +
    `<Stream${xmlAttributes({ url: websocketUrl })}>${parameterXml(customParameters)}</Stream>` +
    '</Connect></Response>'
  );
}

export function buildHangupTwiml(message) {
  return `${XML_PROLOG}<Response><Say>${escapeXml(message)}</Say><Hangup /></Response>`;
}

export function buildEmptyTwiml() {
  return `${XML_PROLOG}<Response></Response>`;
}
