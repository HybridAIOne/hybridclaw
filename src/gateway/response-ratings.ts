import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  clearResponseRating,
  getResponseRatingTarget,
  upsertResponseRating,
} from '../memory/db.js';
import { recordSkillFeedbackForObservation } from '../skills/skills-observation.js';
import type {
  ResponseRatingRecord,
  ResponseRatingValue,
} from '../types/session.js';

export interface SubmitResponseRatingInput {
  sessionId: string;
  messageId: number;
  operatorUserId: string;
  rating: ResponseRatingValue | null;
  sourceSurface?: string | null;
}

export interface SubmitResponseRatingResult {
  sessionId: string;
  messageId: number;
  rating: ResponseRatingValue | null;
  record: ResponseRatingRecord | null;
}

function toSkillFeedbackSentiment(
  rating: ResponseRatingValue,
): 'positive' | 'negative' {
  return rating === 'up' ? 'positive' : 'negative';
}

function formatSkillFeedback(input: {
  rating: ResponseRatingValue;
  operatorUserId: string;
  messageId: number;
  sourceSurface: string;
}): string {
  const label = input.rating === 'up' ? 'thumbs_up' : 'thumbs_down';
  return `${label} from ${input.operatorUserId} on ${input.sourceSurface} response ${input.messageId}`;
}

export function submitResponseRating(
  input: SubmitResponseRatingInput,
): SubmitResponseRatingResult {
  const sessionId = input.sessionId.trim();
  const operatorUserId = input.operatorUserId.trim() || 'web';
  const sourceSurface = input.sourceSurface?.trim() || 'web';
  const target = getResponseRatingTarget({
    sessionId,
    messageId: input.messageId,
  });
  if (!target) {
    throw new Error('Response message was not found.');
  }
  if (target.role !== 'assistant') {
    throw new Error('Only assistant responses can be rated.');
  }

  let record: ResponseRatingRecord | null = null;
  if (input.rating) {
    record = upsertResponseRating({
      sessionId,
      messageId: input.messageId,
      operatorUserId,
      sourceSurface,
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
      sourceSurface,
    });
  }

  if (input.rating && target.skill_observation_id) {
    recordSkillFeedbackForObservation({
      observationId: target.skill_observation_id,
      sessionId,
      feedback: formatSkillFeedback({
        rating: input.rating,
        operatorUserId,
        messageId: input.messageId,
        sourceSurface,
      }),
      sentiment: toSkillFeedbackSentiment(input.rating),
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
      sourceSurface,
      rating: input.rating,
      ratedAt: new Date().toISOString(),
    },
  });

  return {
    sessionId,
    messageId: input.messageId,
    rating: input.rating,
    record,
  };
}
