/**
 * Durable follow-through attached to the existing tracked item.
 * References name evidence, never grant access; review decisions never send mail.
 */

import type { EmailDraft } from '#shared/email-draft.js';
import type { JobContract } from './tracked-verification.js';

export const TRACK_PHASES = [
  'in_progress',
  'needs_you',
  'waiting',
  'blocked',
] as const;
export type TrackPhase = (typeof TRACK_PHASES)[number];
export type TrackReference =
  | { kind: 'message'; session_id: string; message_id: number }
  | { kind: 'work'; work_id: string }
  | { kind: 'receipt'; session_id: string; receipt_id: string };

export interface TrackReview {
  source: Extract<TrackReference, { kind: 'message' }>;
  draft: EmailDraft;
  revision: number;
  state: 'pending' | 'deferred' | 'approved' | 'declined';
  deferred_until: string | null;
  decided_at: string | null;
}

export interface FollowThrough {
  owner: string;
  origin_session_id: string;
  phase: TrackPhase;
  references: TrackReference[];
  job?: JobContract;
  reviews: TrackReview[];
  // A retry returns current state without repeating the original decision.
  requests: { id: string; fingerprint: string }[];
}

export function newFollowThrough(
  owner: string,
  sessionId: string,
): FollowThrough {
  return {
    owner,
    origin_session_id: sessionId,
    phase: 'in_progress',
    references: [],
    reviews: [],
    requests: [],
  };
}
