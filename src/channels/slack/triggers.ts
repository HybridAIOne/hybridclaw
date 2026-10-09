/**
 * Which Slack messages may start a Slack trigger (`event-triggers.ts`):
 * channel messages from people, in channels where the Slack config lets
 * the bot hear them (`groupPolicy`, `groupAllowFrom`), whether or not they
 * mention the bot. Direct and group direct messages never do: they are
 * private to their members. NOT inbound routing, which decides whether the
 * bot answers.
 */
import type { RuntimeSlackConfig } from '../../config/runtime-config.js';
import {
  evaluateSlackAccessPolicy,
  isSlackDmEvent,
  type SlackMessageEvent,
} from './inbound.js';
import { normalizeSlackUserId, parseSlackChannelTarget } from './target.js';

export interface SlackTriggerCandidate {
  channelId: string;
  ts: string;
  userId: string;
  text: string;
}

export function slackTriggerCandidate(
  event: SlackMessageEvent,
  botUserId: string | null,
  config: Pick<
    RuntimeSlackConfig,
    'dmPolicy' | 'groupPolicy' | 'allowFrom' | 'groupAllowFrom'
  >,
): SlackTriggerCandidate | null {
  const subtype = String(event.subtype || '').trim();
  if (String(event.bot_id || '').trim()) return null;
  if (subtype && subtype !== 'file_share') return null;
  if (isSlackDmEvent(event) || event.channel_type === 'mpim') return null;
  const userId = normalizeSlackUserId(event.user);
  const channelId = parseSlackChannelTarget(event.channel)?.channelId;
  const ts = String(event.ts || '').trim();
  const text = String(event.text || '').trim();
  if (!userId || !channelId || !ts || !text || userId === botUserId)
    return null;
  const allowed = evaluateSlackAccessPolicy({
    dmPolicy: config.dmPolicy,
    groupPolicy: config.groupPolicy,
    allowFrom: config.allowFrom,
    groupAllowFrom: config.groupAllowFrom,
    userId,
    isDm: false,
  });
  return allowed ? { channelId, ts, userId, text } : null;
}
