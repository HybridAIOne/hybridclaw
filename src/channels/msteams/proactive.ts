/**
 * Teams proactive delivery: scheduled, heartbeat, and queued output reaches a
 * Teams conversation only through the Bot Framework reference stored when the
 * bot last received a message there. It never opens a conversation the bot has
 * not seen, so a target without a stored reference fails explicitly.
 *
 * NOT the message tool's Teams send (`tool-actions.ts`), which stays limited
 * to the current Teams session; quiet hours and queuing live in dispatch.
 */
import { logger } from '../../logger.js';
import { getAllSessions } from '../../memory/db.js';
import type { ArtifactMetadata } from '../../types/execution.js';
import type { ProactiveDeliveryOutcome } from '../channel-descriptor.js';
import {
  msteamsAttachmentsLoader,
  msteamsRuntimeLoader,
} from '../channel-runtime-loaders.js';
import {
  MSTEAMS_ARTIFACT_DELIVERY_NOTICE,
  stripUnusableMSTeamsArtifactLinks,
} from './delivery.js';
import { parseTeamsConversationId } from './inbound.js';
import type { StoredMSTeamsSession } from './runtime.js';
import {
  isMSTeamsSession,
  isRecord,
  normalizeValue,
  resolveMSTeamsSessionKey,
} from './utils.js';

// References are stored per session; the target is the conversation id. A
// team channel's base id borrows a thread's reference to post top-level.
function findStoredReference(
  target: string,
  read: (sessionKey: string) => StoredMSTeamsSession | null,
): StoredMSTeamsSession | null {
  const sessions = getAllSessions().filter(isMSTeamsSession);
  const readFor = (match: (channelId: string) => boolean) => {
    for (const session of sessions) {
      if (!match(normalizeValue(session.channel_id))) continue;
      const stored = read(resolveMSTeamsSessionKey(session));
      if (stored) return stored;
    }
    return null;
  };
  const exact = readFor((channelId) => channelId === target);
  if (exact || parseTeamsConversationId(target).messageId) return exact;
  const thread = readFor(
    (channelId) => parseTeamsConversationId(channelId).baseId === target,
  );
  if (!thread) return null;
  const { reference } = thread;
  return {
    ...thread,
    channelId: target,
    replyStyle: 'top-level',
    replyToId: null,
    reference: {
      ...reference,
      conversation: { ...reference.conversation, id: target },
    },
  };
}

export async function sendProactive(
  channelId: string,
  text: string,
  _source: string,
  artifacts?: ArtifactMetadata[],
): Promise<ProactiveDeliveryOutcome> {
  const target = normalizeValue(channelId);
  const runtime = await msteamsRuntimeLoader.load();
  const stored = findStoredReference(
    target,
    runtime.readStoredConversationReference,
  );
  if (!stored) {
    return {
      status: 'failed',
      reason: `No stored Microsoft Teams conversation reference for "${target}". The bot can only message a Teams conversation it has received a message in; send it a message there first.`,
    };
  }
  const cleaned = stripUnusableMSTeamsArtifactLinks(text);
  try {
    await runtime.sendViaConversationReference(stored, async (turnContext) => {
      if (!artifacts?.length) return { text: cleaned };
      try {
        const { buildTeamsArtifactAttachments } =
          await msteamsAttachmentsLoader.load();
        return {
          text: cleaned,
          attachments: await buildTeamsArtifactAttachments({
            turnContext,
            artifacts,
          }),
        };
      } catch (error) {
        logger.warn(
          { error, artifactCount: artifacts.length },
          'Failed to build Teams proactive artifact attachments',
        );
        return {
          text: cleaned
            ? `${cleaned}\n\n${MSTEAMS_ARTIFACT_DELIVERY_NOTICE}`
            : MSTEAMS_ARTIFACT_DELIVERY_NOTICE,
        };
      }
    });
  } catch (error) {
    const status = isRecord(error) ? error.statusCode : null;
    if (status !== 401 && status !== 403 && status !== 404) throw error;
    return {
      status: 'failed',
      reason: `${error instanceof Error ? error.message : String(error)}. The stored Teams conversation reference may be stale; send the bot a message in that conversation to refresh it.`,
    };
  }
  return { status: 'delivered' };
}
