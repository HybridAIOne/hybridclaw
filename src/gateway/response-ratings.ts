import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  getHybridAIApiKey,
  getHybridAIAuthStatus,
} from '../auth/hybridai-auth.js';
import {
  HYBRIDAI_BASE_URL,
  HYBRIDAI_CHATBOT_ID,
  OBSERVABILITY_BOT_ID,
} from '../config/config.js';
import { logger } from '../logger.js';
import {
  clearResponseRating,
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
}

export interface SubmitResponseRatingResult {
  sessionId: string;
  messageId: number;
  rating: ResponseRatingValue | null;
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

function resolveHybridAIChatFeedbackBotId(
  sessionChatbotId: string | null | undefined,
): string {
  return (
    sessionChatbotId?.trim() ||
    OBSERVABILITY_BOT_ID.trim() ||
    HYBRIDAI_CHATBOT_ID.trim() ||
    ''
  );
}

function warnHybridAIChatFeedbackForwardingFailed(
  context: Record<string, unknown>,
): void {
  logger.warn(context, 'HybridAI chat feedback forwarding failed');
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
  rating: ResponseRatingValue;
  target: ResponseRatingTarget;
}): Promise<void> {
  let apiKey = '';
  try {
    if (!getHybridAIAuthStatus().authenticated) return;
    apiKey = getHybridAIApiKey();
  } catch {
    return;
  }

  const chatbotId = resolveHybridAIChatFeedbackBotId(input.target.chatbot_id);
  if (!chatbotId) return;

  const agentId = input.target.agent_id?.trim();
  const payload = {
    chatbot_id: chatbotId,
    browser_id: resolveHybridAIChatFeedbackBrowserId(input.sessionId),
    rating: input.rating,
    user_message: input.target.user_content ?? '',
    bot_response: agentId
      ? `[${agentId}] ${input.target.assistant_content}`
      : input.target.assistant_content,
    external_user_id: input.operatorUserId,
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

export function submitResponseRating(
  input: SubmitResponseRatingInput,
): SubmitResponseRatingResult {
  const sessionId = input.sessionId.trim();
  if (!sessionId) throw new Error('Missing `sessionId`.');
  const operatorUserId = input.operatorUserId.trim() || 'web';
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
      feedback: `${skillFeedbackLabel} from ${operatorUserId} on web response ${input.messageId}`,
      sentiment: input.rating === 'up' ? 'positive' : 'negative',
    });
  }

  recordAuditEvent({
    sessionId,
    runId: makeAuditRunId('rating'),
    event: {
      type: 'response.rating',
      sessionId,
      messageId: input.messageId,
      agentId: target.agent_id,
      model: target.model,
      provider: target.provider,
      skillName: target.skill_name,
      skillRunId: target.skill_run_id,
      skillObservationId: target.skill_observation_id,
      operatorUserId,
      sourceSurface: 'web',
      rating: input.rating,
      ratedAt: new Date().toISOString(),
    },
  });

  if (input.rating) {
    void forwardHybridAIChatFeedbackForRating({
      sessionId,
      messageId: input.messageId,
      operatorUserId,
      rating: input.rating,
      target,
    });
  }

  return {
    sessionId,
    messageId: input.messageId,
    rating: input.rating,
  };
}
