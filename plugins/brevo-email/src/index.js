import { resolveAgentEmailAddress } from './brevo-address.js';
import { handleBrevoInbound } from './brevo-inbound.js';
import { createBrevoSmtpService } from './brevo-outbound.js';
import { resolveBrevoConfig } from './config.js';

export default {
  id: 'brevo-email',
  kind: 'channel',
  register(api) {
    const config = resolveBrevoConfig(api.pluginConfig, api);
    const { service, send } = createBrevoSmtpService(config, api.logger);

    api.registerService(service);

    api.registerInboundWebhook({
      name: 'inbound',
      method: 'POST',
      description: 'Brevo inbound email parsing webhook',
      async handler(ctx) {
        await handleBrevoInbound(ctx, api, config);
      },
    });

    api.registerTool({
      name: 'send_email',
      description:
        "Send an email from this agent's Brevo-provisioned address. " +
        'Use for outbound communication when asked to email someone.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Recipient email address',
          },
          subject: {
            type: 'string',
            description: 'Email subject line',
          },
          body: {
            type: 'string',
            description: 'Plain text email body',
          },
          cc: {
            type: 'string',
            description: 'CC recipient (optional)',
          },
          bcc: {
            type: 'string',
            description: 'BCC recipient (optional)',
          },
        },
        required: ['to', 'subject', 'body'],
      },
      async handler(args, context) {
        const defaultAgentId = api.config.agents?.defaultAgentId || 'main';
        let agentId = defaultAgentId;
        const match = context.sessionId.match(/^agent:([^:]+):channel:/);
        if (match) agentId = decodeURIComponent(match[1]);
        const address = config.fromAddress ||
          resolveAgentEmailAddress(agentId, config.domain);
        const from = config.fromName
          ? `"${config.fromName}" <${address}>`
          : address;
        await send({
          from,
          to: String(args.to),
          subject: String(args.subject),
          body: String(args.body),
          ...(args.cc ? { cc: String(args.cc) } : {}),
          ...(args.bcc ? { bcc: String(args.bcc) } : {}),
        });
        return { sent: true, from, to: args.to, subject: args.subject };
      },
    });

    api.logger.info(
      { domain: config.domain, smtpHost: config.smtpHost },
      'Brevo email plugin registered',
    );
  },
};
