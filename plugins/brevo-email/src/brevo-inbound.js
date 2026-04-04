import { resolveAgentIdFromRecipient } from './brevo-address.js';

const MAX_DEDUP_SIZE = 2000;

/**
 * Simple LRU-ish dedup set for webhook message IDs.
 * Prevents reprocessing when Brevo retries a delivery.
 */
const seenMessageIds = new Set();

function recordMessageId(messageId) {
  if (!messageId) return false;
  if (seenMessageIds.has(messageId)) return true;
  seenMessageIds.add(messageId);
  if (seenMessageIds.size > MAX_DEDUP_SIZE) {
    const first = seenMessageIds.values().next().value;
    seenMessageIds.delete(first);
  }
  return false;
}

/**
 * Build the session key for an inbound email.
 *
 * Mirrors the canonical format from `src/session/session-key.ts`:
 * `agent:{agentId}:channel:email:chat:dm:peer:{encodedSender}`
 *
 * @param {string} agentId
 * @param {string} senderAddress
 * @returns {string}
 */
function buildEmailSessionKey(agentId, senderAddress) {
  const encode = (v) => encodeURIComponent(String(v).trim().toLowerCase());
  return [
    'agent', encode(agentId),
    'channel', 'email',
    'chat', 'dm',
    'peer', encode(senderAddress),
  ].join(':');
}

/**
 * Extract plain text from a Brevo inbound item.
 *
 * @param {import('./types.js').BrevoInboundItem} item
 * @returns {string}
 */
function extractText(item) {
  if (item.RawTextBody) return item.RawTextBody;
  if (item.RawHtmlBody) {
    return item.RawHtmlBody
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .trim();
  }
  return '';
}

/**
 * Build a text representation of attachments for the agent.
 *
 * @param {import('./types.js').BrevoAttachment[]} attachments
 * @returns {string}
 */
function describeAttachments(attachments) {
  if (!attachments || attachments.length === 0) return '';
  const lines = attachments.map(
    (a) => `- ${a.Name} (${a.ContentType}, ${Math.round(a.ContentLength / 1024)}KB)`,
  );
  return `\n\nAttachments:\n${lines.join('\n')}`;
}

/**
 * Handle a Brevo inbound parsing webhook request.
 *
 * @param {import('hybridclaw/plugin-sdk').PluginInboundWebhookContext} ctx
 * @param {import('hybridclaw/plugin-sdk').HybridClawPluginApi} api
 * @param {import('./types.js').BrevoEmailConfig} config
 */
export async function handleBrevoInbound(ctx, api, config) {
  const { readWebhookJsonBody, sendWebhookJson, WebhookHttpError } =
    await import('hybridclaw/plugin-sdk');

  if (config.webhookSecret) {
    const provided = ctx.req.headers['x-brevo-secret'] || '';
    if (provided !== config.webhookSecret) {
      throw new WebhookHttpError(401, 'Invalid webhook secret.');
    }
  }

  const body = /** @type {import('./types.js').BrevoInboundPayload} */ (
    await readWebhookJsonBody(ctx.req, {
      maxBytes: config.maxBodyBytes,
      tooLargeMessage: 'Brevo inbound payload too large.',
      invalidJsonMessage: 'Brevo inbound payload is not valid JSON.',
    })
  );

  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) {
    sendWebhookJson(ctx.res, 200, { ok: true, processed: 0 });
    return;
  }

  let processed = 0;

  for (const item of items) {
    const messageId = item.MessageId || '';
    if (recordMessageId(messageId)) {
      ctx.logger.debug({ messageId }, 'Skipping duplicate inbound email');
      continue;
    }

    const from = item.From;
    if (!from?.Address) {
      ctx.logger.warn({ messageId }, 'Inbound item missing From address');
      continue;
    }
    const senderAddress = from.Address.trim().toLowerCase();
    const senderName = from.Name || senderAddress;

    const recipients = Array.isArray(item.To) ? item.To : [];
    const targetRecipient = recipients.find(
      (r) => resolveAgentIdFromRecipient(r.Address, config.domain) !== null,
    );
    if (!targetRecipient) {
      ctx.logger.debug(
        { messageId, to: recipients.map((r) => r.Address) },
        'No matching agent for inbound email recipients',
      );
      continue;
    }

    const agentId = resolveAgentIdFromRecipient(
      targetRecipient.Address,
      config.domain,
    );
    if (!agentId) continue;

    const subject = String(item.Subject || '').trim();
    const bodyText = extractText(item);
    const attachmentSummary = describeAttachments(item.Attachments || []);

    const contentParts = [];
    if (subject) contentParts.push(`Subject: ${subject}`);
    if (bodyText) contentParts.push(bodyText);
    if (attachmentSummary) contentParts.push(attachmentSummary);

    const content = contentParts.join('\n\n');
    if (!content) {
      ctx.logger.debug({ messageId, agentId }, 'Empty inbound email, skipping');
      continue;
    }

    const sessionId = buildEmailSessionKey(agentId, senderAddress);

    try {
      await api.dispatchInboundMessage({
        sessionId,
        channelId: senderAddress,
        userId: senderAddress,
        username: senderName,
        content,
        agentId,
      });
      processed++;
      ctx.logger.info(
        { messageId, agentId, senderAddress, subject },
        'Brevo inbound email dispatched',
      );
    } catch (error) {
      ctx.logger.error(
        { error, messageId, agentId, senderAddress },
        'Failed to dispatch inbound email',
      );
    }
  }

  sendWebhookJson(ctx.res, 200, { ok: true, processed });
}
