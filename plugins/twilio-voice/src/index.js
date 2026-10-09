/**
 * Twilio Voice plugin: phone calls on the core `voice` channel through
 * Twilio ConversationRelay (`voice.mode: relay`) or Media Streams with the
 * core realtime engine (`voice.mode: realtime`).
 *
 * Settings stay in the core `voice.*` config (shared with other phone
 * transports and edited in the console under Channels → Voice); the plugin
 * owns only the Twilio wire protocols, request authentication, and the
 * `/voice` command. `/voice call` places real calls, so it is limited to
 * local operators holding `admin.channels.write`.
 */

import { createTwilioVoiceRuntime } from './runtime.js';
import {
  createTwilioOutboundCall,
  normalizeTwilioPhoneNumber,
} from './twilio-api.js';
import { TWILIO_VOICE_PATHS } from './urls.js';

const USAGE = 'Usage: `voice [info|call <e164-number>]`';

function voiceInfo(api, runtime) {
  const settings = api.getVoiceConfig();
  const baseUrl = api.getPublicBaseUrl();
  return [
    'Twilio Voice',
    `Enabled: ${settings.enabled ? 'on' : 'off'}`,
    `Mode: ${settings.mode}`,
    `Account SID: ${settings.twilio.accountSid.trim() ? 'configured' : 'unset'}`,
    `From number: ${settings.twilio.fromNumber.trim() || '(unset)'}`,
    `Auth token: ${runtime.resolveAuthToken() ? 'configured' : 'unset'}`,
    baseUrl
      ? `Webhook: ${baseUrl}${TWILIO_VOICE_PATHS.webhook}`
      : `Webhook: <public-host>${TWILIO_VOICE_PATHS.webhook} (set ops.gatewayBaseUrl to a public URL)`,
    `Realtime speech: ${api.isRealtimeVoiceAvailable() ? 'credential configured' : 'no credential'} (details: /speech)`,
    'Usage: `voice call <e164-number>`',
  ].join('\n');
}

async function placeCall(api, runtime, rawNumber) {
  const settings = api.getVoiceConfig();
  if (!settings.enabled) {
    throw new Error('Enable `voice.enabled` before using `voice call`.');
  }
  const to = normalizeTwilioPhoneNumber(rawNumber);
  if (!to) throw new Error(USAGE);
  const accountSid = settings.twilio.accountSid.trim();
  if (!accountSid) {
    throw new Error('Set `voice.twilio.accountSid` before using `voice call`.');
  }
  const from = normalizeTwilioPhoneNumber(settings.twilio.fromNumber);
  if (!from) {
    throw new Error(
      'Set `voice.twilio.fromNumber` to an E.164 number like `+14155550123` before using `voice call`.',
    );
  }
  const authToken = runtime.resolveAuthToken();
  if (!authToken) {
    throw new Error(
      'Store `TWILIO_AUTH_TOKEN` in the encrypted secret store before using `voice call`.',
    );
  }
  const baseUrl = api.getPublicBaseUrl();
  if (!baseUrl) {
    throw new Error(
      'Set `ops.gatewayBaseUrl` (or `deployment.public_url` in cloud mode) to a public URL before using `voice call`; Twilio cannot reach localhost or private-network webhooks.',
    );
  }
  const call = await createTwilioOutboundCall({
    accountSid,
    authToken,
    from,
    to,
    url: `${baseUrl}${TWILIO_VOICE_PATHS.webhook}`,
  });
  return `Calling ${call.to} from ${call.from} via Twilio (Call SID: ${call.sid}, status: ${call.status}).`;
}

const SUBCOMMANDS = {
  info: (api, runtime) => voiceInfo(api, runtime),
  status: (api, runtime) => voiceInfo(api, runtime),
  call: (api, runtime, args) => placeCall(api, runtime, args.join(' ')),
};

export default {
  id: 'twilio-voice',
  kind: 'channel',
  register(api) {
    const runtime = createTwilioVoiceRuntime(api);

    api.registerInboundWebhook({
      name: 'webhook',
      method: 'POST',
      description: 'Twilio incoming-call webhook (returns TwiML)',
      handler: (ctx) => runtime.handleIncomingCall(ctx),
    });
    api.registerInboundWebhook({
      name: 'action',
      method: 'POST',
      description: 'Twilio <Connect> action callback',
      handler: (ctx) => runtime.handleAction(ctx),
    });
    api.registerWebsocketWebhook({
      name: 'relay',
      description: 'Twilio ConversationRelay text socket (relay mode)',
      handler: (ctx) => runtime.handleRelayUpgrade(ctx),
    });
    api.registerWebsocketWebhook({
      name: 'stream',
      description: 'Twilio Media Streams audio socket (realtime mode)',
      handler: (ctx) => runtime.handleStreamUpgrade(ctx),
    });
    api.registerService({
      id: 'twilio-voice-runtime',
      stop: () => runtime.stop(),
    });
    api.registerCommand({
      name: 'voice',
      description: 'Show Twilio voice status or place an outbound call',
      adminAction: 'admin.channels.write',
      async handler(args) {
        const subcommand = String(args[0] || 'info').toLowerCase();
        if (!Object.hasOwn(SUBCOMMANDS, subcommand)) throw new Error(USAGE);
        return SUBCOMMANDS[subcommand](api, runtime, args.slice(1));
      },
    });
    runtime.logReady();
  },
};
