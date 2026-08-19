import { getMemoryValue, setMemoryValue } from '../../memory/db.js';
import type { ResponseRatingValue } from '../../types/session.js';
import {
  isRecord,
  MSTEAMS_RATING_TARGETS_KEY,
  normalizeValue,
} from './utils.js';

const MAX_RATING_TARGETS = 100;

interface StoredRatingTarget {
  activityId: string;
  messageId: number;
}

function readStoredRatingTargets(sessionId: string): StoredRatingTarget[] {
  const stored = getMemoryValue(sessionId, MSTEAMS_RATING_TARGETS_KEY);
  if (!Array.isArray(stored)) return [];
  const targets: StoredRatingTarget[] = [];
  for (const entry of stored) {
    if (!isRecord(entry)) continue;
    const activityId = normalizeValue(String(entry.activityId ?? ''));
    const messageId = Number(entry.messageId);
    if (!activityId || !Number.isInteger(messageId) || messageId <= 0) {
      continue;
    }
    targets.push({ activityId, messageId });
  }
  return targets;
}

export function recordMSTeamsRatingTargets(params: {
  sessionId: string;
  activityIds: string[];
  messageId: number;
}): void {
  const activityIds = [
    ...new Set(params.activityIds.map((id) => normalizeValue(id))),
  ].filter(Boolean);
  if (
    activityIds.length === 0 ||
    !Number.isInteger(params.messageId) ||
    params.messageId <= 0
  ) {
    return;
  }
  const targets = readStoredRatingTargets(params.sessionId).filter(
    (entry) => !activityIds.includes(entry.activityId),
  );
  for (const activityId of activityIds) {
    targets.push({ activityId, messageId: params.messageId });
  }
  setMemoryValue(
    params.sessionId,
    MSTEAMS_RATING_TARGETS_KEY,
    targets.slice(-MAX_RATING_TARGETS),
  );
}

export function resolveMSTeamsRatingTarget(
  sessionId: string,
  activityId: string,
): number | null {
  const normalized = normalizeValue(activityId);
  if (!normalized) return null;
  const target = readStoredRatingTargets(sessionId).find(
    (entry) => entry.activityId === normalized,
  );
  return target?.messageId ?? null;
}

// Teams delivers messageReaction events for its standard reaction set; the
// dislike/thumbsdown aliases cover clients that expose a thumbs-down reaction.
const REACTION_RATINGS: Record<string, ResponseRatingValue> = {
  like: 'up',
  plusone: 'up',
  '+1': 'up',
  thumbsup: 'up',
  yes: 'up',
  dislike: 'down',
  minusone: 'down',
  '-1': 'down',
  thumbsdown: 'down',
  no: 'down',
};

export function mapMSTeamsReactionToRating(
  type: string | null | undefined,
): ResponseRatingValue | null {
  const normalized = normalizeValue(String(type ?? '')).toLowerCase();
  return REACTION_RATINGS[normalized] ?? null;
}
