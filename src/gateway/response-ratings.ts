import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  clearResponseRating,
  getResponseRatingTarget,
  upsertResponseRating,
} from '../memory/db.js';
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

  return {
    sessionId,
    messageId: input.messageId,
    rating: input.rating,
  };
}
