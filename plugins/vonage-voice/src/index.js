import { createVonageOutboundCall } from './api.js';
import { normalizePhoneNumber, resolveConfig } from './config.js';
import { createVonageRuntime } from './runtime.js';

export default {
  id: 'vonage-voice',
  kind: 'channel',
  register(api) {
    const config = resolveConfig(api);
    const runtime = createVonageRuntime(api, config);

    api.registerInboundWebhook({
      name: 'answer',
      method: 'POST',
      description: 'Vonage answer callback',
      handler: (ctx) => runtime.handleAnswer(ctx),
    });
    api.registerInboundWebhook({
      name: 'input',
      method: 'POST',
      description: 'Vonage speech input callback',
      handler: (ctx) => runtime.handleInput(ctx),
    });
    api.registerInboundWebhook({
      name: 'event',
      method: 'POST',
      description: 'Vonage call status callback',
      handler: (ctx) => runtime.handleEvent(ctx),
    });
    api.registerService({
      id: 'vonage-voice-runtime',
      stop: () => runtime.stop(),
    });
    api.registerCommand({
      name: 'vonage',
      description: 'Show Vonage Voice status or place a call',
      async handler(args) {
        const subcommand = String(args[0] || 'info').toLowerCase();
        if (subcommand === 'info' || subcommand === 'status') {
          return [
            'Vonage Voice plugin is ready.',
            `Answer webhook: ${runtime.answerUrl}`,
            `Event webhook: ${runtime.eventUrl}`,
            'Usage: /vonage call <e164-number>',
          ].join('\n');
        }
        if (subcommand !== 'call') {
          throw new Error('Usage: /vonage [info|call <e164-number>]');
        }
        const to = normalizePhoneNumber(args.slice(1).join(''));
        if (!to) throw new Error('Destination must be an E.164 phone number.');
        const call = await createVonageOutboundCall({
          applicationId: config.applicationId,
          privateKey: config.privateKey,
          from: config.fromNumber,
          to,
          answerUrl: runtime.answerUrl,
          eventUrl: runtime.eventUrl,
        });
        return `Calling ${to} via Vonage (call UUID: ${call.uuid}, status: ${call.status}).`;
      },
    });
  },
};
