import { resolveAgentEmailAddress } from './brevo-address.js';
import {
  createBrevoCommandHandler,
  resolveCurrentAgentId,
} from './brevo-command.js';
import { buildKnownAgentIds, handleBrevoInbound } from './brevo-inbound.js';
import { createBrevoSmtpService } from './brevo-outbound.js';
import { resolveBrevoConfig } from './config.js';

const EMAIL_ADDRESS_RE = /^[^\s@<>]+@[^\s@<>]+$/;
// Mirrors the core email channel's message-id check (src/channels/email/
// threading.ts): a value that is not a message id names nothing a mail client
// can thread on, and writing it into In-Reply-To/References detaches the reply
// from its thread instead.
const MESSAGE_ID_RE = /^<[^<>\s@]+@[^<>\s@]+>$/;

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

const IGNORED_THREAD_ID_NOTE =
  'Ignored: not an email message id. The email was sent without it. Omit ' +
  'inReplyTo/references unless you are replying to a specific message, and ' +
  'then pass that message’s Message-ID verbatim.';

/**
 * Return *value* as a message id, or null when it is not one.
 *
 * A value that is not a message id names nothing a mail client can thread on,
 * so writing it into In-Reply-To/References detaches the reply from its
 * thread. Dropping it is reported back in the tool result rather than failing
 * the send: the email itself is what the caller actually wanted.
 */
function asThreadMessageId(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  const candidate = trimmed.startsWith('<') ? trimmed : `<${trimmed}>`;
  return MESSAGE_ID_RE.test(candidate) ? candidate : null;
}

function resolveThreadReferences(inReplyTo, references) {
  const normalized = references ? [...new Set(references)] : [];
  if (normalized.length > 0) {
    if (inReplyTo && !normalized.includes(inReplyTo)) {
      normalized.push(inReplyTo);
    }
    return normalized;
  }
  return inReplyTo ? [inReplyTo] : undefined;
}

export function createSendEmailToolHandler(api, config, send) {
  return async (args, context) => {
    const to = requireEmailAddress('to', args.to);
    const cc = args.cc ? requireEmailAddress('cc', args.cc) : undefined;
    const bcc = args.bcc ? requireEmailAddress('bcc', args.bcc) : undefined;
    const ignoredThreadIds = [];
    const requestedInReplyTo = normalizeOptionalString(
      'inReplyTo',
      args.inReplyTo,
    );
    const inReplyTo = asThreadMessageId(requestedInReplyTo) || undefined;
    if (requestedInReplyTo && !inReplyTo) {
      ignoredThreadIds.push(requestedInReplyTo);
    }
    const requestedReferences =
      normalizeOptionalStringList('references', args.references) || [];
    const validReferences = [];
    for (const entry of requestedReferences) {
      const messageId = asThreadMessageId(entry);
      if (messageId) {
        validReferences.push(messageId);
        continue;
      }
      ignoredThreadIds.push(entry);
    }
    const references = resolveThreadReferences(
      inReplyTo,
      validReferences.length > 0 ? validReferences : undefined,
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
    return {
      sent: true,
      from,
      to,
      subject: args.subject,
      ...(ignoredThreadIds.length > 0
        ? { ignoredThreadIds, ignoredThreadIdsNote: IGNORED_THREAD_ID_NOTE }
        : {}),
    };
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
