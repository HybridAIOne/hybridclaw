/**
 * Message-tool sends over plugin channels: always from the linked account,
 * reporting only what the transport knows.
 *
 * Target resolution asks each registered transport in catalog order. Without
 * the plugin, the channel's catalog address syntax still resolves to it, so the
 * send fails with the install hint instead of reaching email or Signal;
 * anything else stays unresolved so the caller can try other channels.
 * Sender overrides are rejected, and socket acceptance is never reported as
 * delivery.
 */

import {
  getPluginChannelCoreFacts,
  getPluginChannelName,
  PLUGIN_CHANNEL_KINDS,
  type PluginChannelKind,
} from '../channel-plugin-catalog.js';
import { getChannelCapabilities } from '../channel-registry.js';
import {
  getChannelTransport,
  requireChannelTransport,
} from '../channel-transport.js';
import { PLUGIN_CHANNEL_DESCRIPTORS } from './descriptor.js';
import { sendPluginChannelMedia, sendPluginChannelText } from './runtime.js';

export function resolvePluginChannelTarget(
  rawTarget: string,
): { kind: PluginChannelKind; channelId: string } | null {
  const trimmed = String(rawTarget || '').trim();
  if (!trimmed) return null;
  for (const kind of PLUGIN_CHANNEL_KINDS) {
    const registration = getChannelTransport(kind);
    const channelId = registration
      ? registration.normalizeTarget(trimmed)
      : getPluginChannelCoreFacts(kind).claimsToolTarget(trimmed)
        ? trimmed
        : null;
    if (channelId) return { kind, channelId };
  }
  return null;
}

export function matchesPluginChannelTarget(target: string): boolean {
  return PLUGIN_CHANNEL_KINDS.some((kind) =>
    PLUGIN_CHANNEL_DESCRIPTORS[kind].matchesTarget(target),
  );
}

export async function sendPluginChannelToolMessage(params: {
  kind: PluginChannelKind;
  channelId: string;
  content: string;
  filePath: string | null;
  hasComponents: boolean;
  from: unknown;
}): Promise<Record<string, unknown>> {
  const { kind, channelId, content, filePath } = params;
  const name = getPluginChannelName(kind);
  const attachments = getChannelCapabilities(kind).attachments;
  if (filePath && !attachments) {
    throw new Error(`filePath is not supported for ${name} sends.`);
  }
  if (!content && !filePath) {
    throw new Error(
      `content is required for ${name} send${attachments ? ' unless filePath is provided' : ''}.`,
    );
  }
  if (params.hasComponents) {
    throw new Error(`components are not supported for ${name} sends.`);
  }

  const registration = requireChannelTransport(kind);
  const auth = await registration.getAuthStatus();
  if (!auth.linked) throw new Error(`${name} is not linked.`);
  const description = registration.describeSend?.({ target: channelId, auth });
  if (params.from !== undefined) {
    throw new Error(
      `from is a read filter and cannot be used for ${name} sends. Messages are sent from ${description?.sentFrom ?? `the linked ${name} account`}. Remove from to send using the linked account.`,
    );
  }

  const result = filePath
    ? await sendPluginChannelMedia(kind, {
        jid: channelId,
        filePath,
        caption: content || undefined,
      })
    : await sendPluginChannelText(kind, channelId, content);
  return {
    ok: true,
    action: 'send',
    channelId,
    transport: kind,
    ...(filePath ? { attachmentCount: 1 } : {}),
    contentLength: content.length,
    ...(description
      ? { sentFrom: description.sentFrom, recipient: description.recipient }
      : {}),
    messageIds: result?.messageIds ?? [],
    deliveryStatus: 'unknown-recipient',
    deliveryConfirmed: false,
    ...(description?.note ? { note: description.note } : {}),
  };
}
