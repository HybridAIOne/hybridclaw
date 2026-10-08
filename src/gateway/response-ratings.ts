/**
 * Response ratings attribute feedback to the submitting user, while the rated
 * agent remains subject metadata. Unlike the audit reader, this service knows
 * who performed the action; it does not infer actors from response ownership.
 * Forwarding requires an explicit bot association; global defaults are not ownership.
 */
import { findAgentConfig } from '../agents/agent-registry.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  getHybridAIApiKey,
  getHybridAIAuthStatus,
} from '../auth/hybridai-auth.js';
import { HYBRIDAI_BASE_URL } from '../config/config.js';
import { createUserActor } from '../identity/actor.js';
import { formatLocalOwnerUserId } from '../identity/agent-id.js';
import { logger } from '../logger.js';
import { findChannelUserEmail } from '../memory/channel-users.js';
import {
  clearResponseRating,
  getResponseRatingsForMessages,
  getResponseRatingTarget,
  type ResponseRatingTarget,
  upsertResponseRating,
} from '../memory/db.js';
import { normalizeBaseUrl } from '../providers/utils.js';
import { recordSkillFeedbackForObservation } from '../skills/skills-observation.js';
import type { ResponseRatingValue } from '../types/session.js';

export interface SubmitResponseRatingInput {
  sessionId: string;
  messageId: number;
  operatorUserId: string;
  rating: ResponseRatingValue | null;
  /** Optional free-text note, e.g. the expected answer for a thumbs-down. */
  comment?: string | null;
  /** Surface the rating came from ('web', 'msteams', ...); defaults to 'web'. */
  sourceSurface?: string;
}

export interface SubmitResponseRatingResult {
  sessionId: string;
  messageId: number;
  rating: ResponseRatingValue | null;
  comment: string | null;
}

export class ResponseRatingNotFoundError extends Error {
  constructor() {
    super('Response message was not found.');
    this.name = 'ResponseRatingNotFoundError';
  }
}

const HYBRIDAI_CHAT_FEEDBACK_TIMEOUT_MS = 10_000;
const HYBRIDAI_CHAT_FEEDBACK_URL = `${normalizeBaseUrl(
  HYBRIDAI_BASE_URL,
)}/api/chat_feedback`;
const HYBRIDAI_DATA_CONTROLS_URL = `${normalizeBaseUrl(
  HYBRIDAI_BASE_URL,
)}/v1/account/data-controls`;

function findRatedAgentConfig(agentId: string | null | undefined) {
  if (!agentId?.trim()) return null;
  try {
    return findAgentConfig(agentId) ?? null;
  } catch {
    return null;
  }
}

function resolveHybridAIChatFeedbackBotId(
  target: Pick<ResponseRatingTarget, 'agent_id' | 'chatbot_id'>,
): string {
  // A proxy agent's answers come from its upstream chatbot, so feedback has
  // to land there rather than on the session's (usually unset) chatbot.
  const agent = findRatedAgentConfig(target.agent_id);
  return (
    agent?.proxy?.chatbotId?.trim() ||
    target.chatbot_id?.trim() ||
    agent?.chatbotId?.trim() ||
    ''
  );
}

function resolveHybridAIChatFeedbackUserId(
  operatorUserId: string,
  sourceSurface: string,
): string {
  // Teams ids are opaque Entra object ids; reviewers need the member's email.
  if (sourceSurface !== 'msteams') return operatorUserId;
  return findChannelUserEmail('msteams', operatorUserId) || operatorUserId;
}

function warnHybridAIChatFeedbackForwardingFailed(
  context: Record<string, unknown>,
): void {
  logger.warn(context, 'HybridAI chat feedback forwarding failed');
}

/**
 * Whether the account agreed that HybridAI may use its ratings to improve the
 * app. The person sets it in the app; the platform keeps it. Anything but a
 * clear yes, an unreachable platform or one without the route included, is no.
 */
async function hasHybridAIProductImprovementConsent(
  apiKey: string,
): Promise<boolean> {
  try {
    const response = await fetch(HYBRIDAI_DATA_CONTROLS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(HYBRIDAI_CHAT_FEEDBACK_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { product_improvement?: unknown };
    return body.product_improvement === true;
  } catch {
    return false;
  }
}

function resolveHybridAIChatFeedbackBrowserId(sessionId: string): string {
  // HybridAI's feedback API requires a stable opaque browser_id. Web ratings
  // are session-scoped and do not expose a separate browser fingerprint here,
  // so use the HybridClaw session id rather than adding user-identifying data.
  return sessionId;
}

async function forwardHybridAIChatFeedbackForRating(input: {
  sessionId: string;
  messageId: number;
  operatorUserId: string;
  sourceSurface: string;
  rating: ResponseRatingValue;
  comment: string | null;
  target: ResponseRatingTarget;
}): Promise<void> {
  let apiKey = '';
  try {
    if (!getHybridAIAuthStatus().authenticated) return;
    apiKey = getHybridAIApiKey();
  } catch {
    return;
  }

  const chatbotId = resolveHybridAIChatFeedbackBotId(input.target);
  if (!chatbotId) return;
  // The phone app's user rates their own assistant; HybridAI gets the rating
  // only with their consent, unlike a workspace's ratings of its own bot.
  if (
    input.sourceSurface === 'mobile' &&
    !(await hasHybridAIProductImprovementConsent(apiKey))
  ) {
    return;
  }

  const agentId = input.target.agent_id?.trim();
  const payload = {
    chatbot_id: chatbotId,
    browser_id: resolveHybridAIChatFeedbackBrowserId(input.sessionId),
    rating: input.rating,
    user_message: input.target.user_content ?? '',
    bot_response: agentId
      ? `[${agentId}] ${input.target.assistant_content}`
      : input.target.assistant_content,
    external_user_id: resolveHybridAIChatFeedbackUserId(
      input.operatorUserId,
      input.sourceSurface,
    ),
    ...(input.rating === 'down' && input.comment
      ? { better_response: input.comment }
      : {}),
  };

  try {
    const response = await fetch(HYBRIDAI_CHAT_FEEDBACK_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(HYBRIDAI_CHAT_FEEDBACK_TIMEOUT_MS),
    });
    if (!response.ok) {
      warnHybridAIChatFeedbackForwardingFailed({
        sessionId: input.sessionId,
        messageId: input.messageId,
        status: response.status,
      });
    }
  } catch (err) {
    warnHybridAIChatFeedbackForwardingFailed({
      sessionId: input.sessionId,
      messageId: input.messageId,
      err,
    });
  }
}

/**
 * Applies channel reaction changes (e.g. Teams 👍/👎) to a response rating.
 * Removals only clear the rating when it matches the removed reaction, so a
 * withdrawn 👍 does not wipe a later explicit /thumbs down.
 */
export function applyReactionRatingChanges(input: {
  sessionId: string;
  messageId: number;
  operatorUserId: string;
  addedRatings: ResponseRatingValue[];
  removedRatings: ResponseRatingValue[];
  sourceSurface: string;
}): SubmitResponseRatingResult | null {
  const current =
    getResponseRatingsForMessages({
      sessionId: input.sessionId,
      messageIds: [input.messageId],
      operatorUserId: input.operatorUserId,
    }).get(input.messageId) ?? null;

  let next: ResponseRatingValue | null | undefined;
  let effective = current;
  for (const rating of input.removedRatings) {
    if (effective === rating) {
      next = null;
      effective = null;
    }
  }
  for (const rating of input.addedRatings) {
    next = rating;
    effective = rating;
  }
  if (next === undefined || next === current) return null;

  return submitResponseRating({
    sessionId: input.sessionId,
    messageId: input.messageId,
    operatorUserId: input.operatorUserId,
    rating: next,
    sourceSurface: input.sourceSurface,
  });
}

export function submitResponseRating(
  input: SubmitResponseRatingInput,
): SubmitResponseRatingResult {
  const sessionId = input.sessionId.trim();
  if (!sessionId) throw new Error('Missing `sessionId`.');
  const operatorUserId = input.operatorUserId.trim() || 'web';
  const comment = input.rating ? input.comment?.trim() || null : null;
  const sourceSurface = input.sourceSurface?.trim().toLowerCase() || 'web';
  const target = getResponseRatingTarget({
    sessionId,
    messageId: input.messageId,
  });
  if (!target) {
    throw new ResponseRatingNotFoundError();
  }
  if (target.role !== 'assistant') {
    throw new Error('Only assistant responses can be rated.');
  }

  if (input.rating) {
    upsertResponseRating({
      sessionId,
      messageId: input.messageId,
      operatorUserId,
      rating: input.rating,
      comment,
      agentId: target.agent_id,
      model: target.model,
      provider: target.provider,
      skillName: target.skill_name,
    });
  } else {
    clearResponseRating({
      sessionId,
      messageId: input.messageId,
      operatorUserId,
    });
  }

  if (input.rating && target.skill_observation_id) {
    const skillFeedbackLabel =
      input.rating === 'up' ? 'thumbs_up' : 'thumbs_down';
    recordSkillFeedbackForObservation({
      observationId: target.skill_observation_id,
      sessionId,
      feedback: `${skillFeedbackLabel} from ${operatorUserId} on ${sourceSurface} response ${input.messageId}${comment ? `: ${comment}` : ''}`,
      sentiment: input.rating === 'up' ? 'positive' : 'negative',
    });
  }

  recordAuditEvent({
    sessionId,
    runId: makeAuditRunId('rating'),
    event: {
      type: 'response.rating',
      actor: createUserActor(formatLocalOwnerUserId(operatorUserId)),
      sessionId,
      messageId: input.messageId,
      agentId: target.agent_id,
      model: target.model,
      provider: target.provider,
      skillName: target.skill_name,
      skillRunId: target.skill_run_id,
      skillObservationId: target.skill_observation_id,
      operatorUserId,
      sourceSurface,
      rating: input.rating,
      comment,
      ratedAt: new Date().toISOString(),
    },
  });

  if (input.rating) {
    void forwardHybridAIChatFeedbackForRating({
      sessionId,
      messageId: input.messageId,
      operatorUserId,
      sourceSurface,
      rating: input.rating,
      comment,
      target,
    });
  }

  return {
    sessionId,
    messageId: input.messageId,
    rating: input.rating,
    comment,
  };
}
