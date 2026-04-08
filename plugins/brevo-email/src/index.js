import { resolveAgentEmailAddress } from './brevo-address.js';
import {
  createBrevoCommandHandler,
  resolveCurrentAgentId,
} from './brevo-command.js';
import { buildKnownAgentIds, handleBrevoInbound } from './brevo-inbound.js';
import { createBrevoSmtpService } from './brevo-outbound.js';
import { resolveBrevoConfig } from './config.js';

const EMAIL_ADDRESS_RE = /^[^\s@<>]+@[^\s@<>]+$/;

function requireEmailAddress(field, value) {
  const email = String(value || '').trim();
  if (!EMAIL_ADDRESS_RE.test(email)) {
    throw new Error(
      `Invalid ${field} email address. Provide a plain email address like user@example.com.`,
    );
  }
  return email;
}

function normalizeOptionalString(field, value) {
  if (value == null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeOptionalStringList(field, value) {
  if (value == null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of strings.`);
  }

  const normalized = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new Error(`${field} entries must be strings.`);
    }
    const trimmed = entry.trim();
    if (!trimmed) continue;
    normalized.push(trimmed);
  }
  return normalized.length > 0 ? normalized : undefined;
}

export function createSendEmailToolHandler(api, config, send) {
  return async (args, context) => {
    const to = requireEmailAddress('to', args.to);
    const cc = args.cc ? requireEmailAddress('cc', args.cc) : undefined;
    const bcc = args.bcc ? requireEmailAddress('bcc', args.bcc) : undefined;
    const inReplyTo = normalizeOptionalString('inReplyTo', args.inReplyTo);
    const references = normalizeOptionalStringList(
      'references',
      args.references,
    );
    const defaultAgentId = api.config.agents?.defaultAgentId || 'main';
    const agentId = resolveCurrentAgentId(api, context, defaultAgentId);
    const configuredHandle = config.agentHandles?.[agentId];
    const address =
      config.fromAddress ||
      resolveAgentEmailAddress(
        agentId,
        config.domain,
        config.fromAddress,
        configuredHandle,
      );
    const from = config.fromName
      ? `"${config.fromName}" <${address}>`
      : address;
    await send({
      from,
      to,
      subject: String(args.subject),
      body: String(args.body),
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references ? { references } : {}),
    });
    return { sent: true, from, to, subject: args.subject };
  };
}

export default {
  id: 'brevo-email',
  kind: 'channel',
  register(api) {
    const config = resolveBrevoConfig(api.pluginConfig, api);
    const knownAgentIds = buildKnownAgentIds(api.config);
    const { service, send } = createBrevoSmtpService(config, api.logger);

    api.registerService(service);

    api.registerCommand({
      name: 'brevo',
      description:
        'Show, list, attach, or detach Brevo email handles for the current agent',
      handler: createBrevoCommandHandler(api, config),
    });

    api.registerInboundWebhook({
      name: 'inbound',
      method: 'POST',
      description: 'Brevo inbound email parsing webhook',
      async handler(ctx) {
        await handleBrevoInbound(ctx, api, config, knownAgentIds);
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
          inReplyTo: {
            type: 'string',
            description:
              'Message-ID for the parent message being replied to when replying in-thread (optional). Use the latest message in the thread.',
          },
          references: {
            type: 'array',
            description:
              'Ordered Message-ID chain for the References header when replying in-thread (optional). End the list with the same parent message used for inReplyTo.',
            items: {
              type: 'string',
            },
          },
        },
        required: ['to', 'subject', 'body'],
      },
      handler: createSendEmailToolHandler(api, config, send),
    });

    api.logger.info(
      { domain: config.domain, smtpHost: config.smtpHost },
      'Brevo email plugin registered',
    );
  },
};
