import type { IncomingMessage } from 'node:http';
import type { RuntimeVoiceRelayConfig } from '../../config/runtime-config.js';

export type TwilioFormBody = Record<string, string>;

function escapeXml(value: string): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function buildXmlAttributes(
  attributes: Record<string, string | undefined>,
): string {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => ` ${name}="${escapeXml(String(value))}"`)
    .join('');
}

function resolveInterruptibleMode(value: boolean): 'any' | 'none' {
  return value ? 'any' : 'none';
}

function toTwilioTtsProvider(
  provider: RuntimeVoiceRelayConfig['ttsProvider'],
): string | undefined {
  if (provider === 'default') {
    return undefined;
  }
  return provider === 'google' ? 'Google' : 'Amazon';
}

function toTwilioTranscriptionProvider(
  provider: RuntimeVoiceRelayConfig['transcriptionProvider'],
): string | undefined {
  if (provider === 'default') {
    return undefined;
  }
  return provider === 'google' ? 'Google' : 'Deepgram';
}

export async function readTwilioFormBody(
  req: IncomingMessage,
): Promise<TwilioFormBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const params = new URLSearchParams(raw);
  const body: TwilioFormBody = {};
  for (const [key, value] of params) {
    body[key] = value;
  }
  return body;
}

export function buildConversationRelayTwiml(params: {
  websocketUrl: string;
  actionUrl: string;
  relay: RuntimeVoiceRelayConfig;
  customParameters?: Record<string, string>;
}): string {
  const relayAttributes = buildXmlAttributes({
    url: params.websocketUrl,
    welcomeGreeting: params.relay.welcomeGreeting,
    welcomeGreetingInterruptible: resolveInterruptibleMode(
      params.relay.interruptible,
    ),
    language: params.relay.language,
    ttsProvider: toTwilioTtsProvider(params.relay.ttsProvider),
    voice: params.relay.voice || undefined,
    transcriptionProvider: toTwilioTranscriptionProvider(
      params.relay.transcriptionProvider,
    ),
    interruptible: resolveInterruptibleMode(params.relay.interruptible),
    reportInputDuringAgentSpeech: 'none',
    preemptible: 'false',
  });
  const parameterXml = Object.entries(params.customParameters || {})
    .map(
      ([name, value]) => `<Parameter${buildXmlAttributes({ name, value })} />`,
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Response><Connect${buildXmlAttributes({ action: params.actionUrl })}>` +
    `<ConversationRelay${relayAttributes}>${parameterXml}</ConversationRelay>` +
    '</Connect></Response>'
  );
}

export function buildHangupTwiml(message: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Response><Say>${escapeXml(message)}</Say><Hangup /></Response>`
  );
}

export function buildEmptyTwiml(): string {
  return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}
