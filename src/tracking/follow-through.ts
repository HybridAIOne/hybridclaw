/**
 * The follow-through projection reuses tracked items, work provenance and receipts.
 * Every reference is authorized again on read; a run finishing never completes an
 * outcome, and no stored phase claims that a worker is currently alive.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { normalizeEmailDraft } from '#shared/email-draft.js';
import { listReceipts } from '../gateway/receipts-command.js';
import {
  canManageScheduledTask,
  canSeeSession,
} from '../gateway/scheduled-task-access.js';
import {
  notificationOperatorId,
  webNotificationSessionOperator,
} from '../gateway/web-notification-store.js';
import { getSessionById } from '../memory/db.js';
import { getJob } from '../memory/jobs.js';
import { getSessionAssistantMessage } from '../memory/messages.js';
import { resolveSessionIdCompat } from '../memory/sessions.js';
import { getScheduledTaskNextRunAt } from '../scheduler/schedule-time.js';
import { beginTurnUser, currentTurnUser } from '../session/turn-user.js';
import { todoOwnerOf } from '../todos/todo-store.js';
import type { Session } from '../types/session.js';
import { stableStringify } from '../utils/stable-json.js';
import { isRecord } from '../utils/type-guards.js';
import {
  listTrackedWork,
  readWork,
  workForMessage,
} from '../work/work-store.js';
import { isWorkActive } from '../work/work-tool.js';
import {
  type FollowThrough,
  newFollowThrough,
  TRACK_PHASES,
  type TrackPhase,
  type TrackReference,
} from './follow-through-types.js';
import {
  appendTrackedNote,
  assertTrackedOwner,
  changeTracked,
  listTracked,
  ownsTrackedCheck,
  setTrackedCompletion,
  TrackError,
  type Tracked,
  trackedView,
} from './track-store.js';

import {
  assertDependencies,
  jobContract,
  jobView,
  MAX_VERIFICATION_ATTEMPTS,
  verifyJob,
} from './tracked-verification.js';

// Engineering bounds (2026-10-24): retain a personal item’s evidence and retry
// identities; fail at the limit rather than evicting a past send decision.
export const followThroughCapabilities = { version: 1, reviews: true };

export function verifiedTrackOwner(session: Session): string {
  const turn = currentTurnUser(session.id);
  const owner = turn?.userId;
  if (!owner || !session.agent_id)
    throw new TrackError('Follow-through needs an authenticated user.');
  const bound = webNotificationSessionOperator(session.id);
  if (bound && bound !== (turn?.operatorId ?? notificationOperatorId(owner)))
    throw new TrackError('This chat belongs to another user.');
  return owner;
}

function canReadTrackSession(
  id: string,
  requester: Session,
  owner: string,
): boolean {
  if (!canSeeSession(id, requester)) return false;
  const bound = webNotificationSessionOperator(id);
  return bound
    ? bound ===
        (currentTurnUser(requester.id)?.operatorId ??
          notificationOperatorId(owner))
    : id === requester.id || getSessionById(id)?.channel_id !== 'web';
}

export function getTracked(session: Session, id: number): Tracked {
  verifiedTrackOwner(session);
  const item = listTracked(session).find((item) => item.id === id);
  if (!item) throw new TrackError('Goal was not found.');
  return item;
}

function text(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new TrackError(`Expected text of 1–${max} characters.`);
  }
  return value.trim();
}

export function trackReference(value: unknown): TrackReference {
  if (!isRecord(value)) throw new TrackError('Expected an evidence reference.');
  switch (value.kind) {
    case 'message':
      if (
        !Number.isSafeInteger(value.message_id) ||
        Number(value.message_id) < 1
      )
        break;
      return {
        kind: 'message',
        session_id: resolveSessionIdCompat(text(value.session_id)),
        message_id: Number(value.message_id),
      };
    case 'work':
      return { kind: 'work', work_id: text(value.work_id) };
    case 'receipt':
      return {
        kind: 'receipt',
        session_id: resolveSessionIdCompat(text(value.session_id)),
        receipt_id: text(value.receipt_id),
      };
  }
  throw new TrackError('Invalid evidence reference.');
}

export function trackEvidence(session: Session, reference: TrackReference) {
  const owner = verifiedTrackOwner(session);
  switch (reference.kind) {
    case 'work': {
      const work = readWork(reference.work_id);
      if (
        !work ||
        work.owner !== owner ||
        work.agentId !== session.agent_id ||
        !canReadTrackSession(work.sessionId, session, owner)
      )
        break;
      return { reference, work };
    }
    case 'message': {
      if (!canReadTrackSession(reference.session_id, session, owner)) break;
      const message = getSessionAssistantMessage(
        reference.session_id,
        reference.message_id,
      );
      const work = workForMessage(reference.session_id, reference.message_id);
      if (
        !message ||
        message.agent_id !== session.agent_id ||
        (work && work.owner !== owner)
      )
        break;
      return { reference, message };
    }
    case 'receipt': {
      const receipt = listReceipts(session, 1, reference)[0];
      if (!receipt) break;
      if (
        !receipt.workId &&
        !canReadTrackSession(receipt.session, session, owner)
      )
        break;
      const work = receipt.workId ? readWork(receipt.workId) : null;
      if (
        work &&
        (work.owner !== owner ||
          work.agentId !== session.agent_id ||
          !canReadTrackSession(work.sessionId, session, owner))
      )
        break;
      return { reference, receipt };
    }
  }
  throw new TrackError(
    'Evidence was not found or is not accessible from this chat.',
  );
}

function dueReview(item: Tracked, now: Date): boolean {
  return (
    item.followThrough?.reviews.some(
      (review) =>
        review.state === 'pending' ||
        (review.state === 'deferred' &&
          Date.parse(review.deferred_until ?? '') <= now.getTime()),
    ) ?? false
  );
}

export function followThroughSummary(
  session: Session,
  item: Tracked,
  now = new Date(),
) {
  const state = item.followThrough;
  const task = ownsTrackedCheck(item)
    ? getJob(item.checkTaskId ?? 0, { kind: 'scheduled_task' })
    : null;
  const next =
    task?.enabled && canManageScheduledTask(task, session)
      ? getScheduledTaskNextRunAt(task, now.getTime())
      : null;
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    revision: item.revision ?? 1,
    phase: item.done
      ? 'completed'
      : dueReview(item, now)
        ? 'needs_you'
        : (state?.phase ?? 'in_progress'),
    status: item.notes.at(-1)?.text ?? null,
    updated_at: item.updatedAt ?? item.createdAt,
    completed_at: item.done?.at ?? null,
    completed_by: item.done?.by ?? null,
    next_check:
      next == null || !task
        ? null
        : { task_id: task.id, at: new Date(next).toISOString() },
    review_count:
      state?.reviews.filter(
        (review) => review.state === 'pending' || review.state === 'deferred',
      ).length ?? 0,
  };
}

export function followThroughDetail(session: Session, item: Tracked) {
  const owner = verifiedTrackOwner(session);
  assertTrackedOwner(session, item);
  // A removed source remains a recorded reference, not an authorization bypass.
  const evidence = (item.followThrough?.references ?? []).map((reference) => {
    try {
      return trackEvidence(session, reference);
    } catch (error) {
      if (!(error instanceof TrackError)) throw error;
      return { reference, unavailable: true };
    }
  });
  const reviews = (item.followThrough?.reviews ?? []).map((review) => {
    try {
      trackEvidence(session, review.source);
      return review;
    } catch (error) {
      if (!(error instanceof TrackError)) throw error;
      return { source: review.source, unavailable: true };
    }
  });
  const origin = item.followThrough?.origin_session_id;
  return {
    ...trackedView(item),
    ...followThroughSummary(session, item),
    source_session_id:
      origin && canReadTrackSession(origin, session, owner) ? origin : null,
    evidence,
    reviews,
    job: jobView(session, item, (reference) =>
      trackEvidence(session, reference),
    ),
    runs: listTrackedWork(
      session.agent_id,
      owner,
      todoOwnerOf(session),
      item.id,
    )
      .filter((work) => canReadTrackSession(work.sessionId, session, owner))
      .map((work) => ({
        ...work,
        active: !work.completedAt && !work.failedAt && isWorkActive(work.id),
      })),
  };
}

function link(
  session: Session,
  item: Tracked,
  state: FollowThrough,
  raw: unknown,
) {
  const reference = trackReference(raw);
  const evidence = trackEvidence(session, reference);
  if (state.references.some((entry) => isDeepStrictEqual(entry, reference)))
    return;
  if (state.references.length >= 100)
    throw new TrackError('An item holds at most 100 evidence links.');
  if (
    'message' in evidence &&
    evidence.message?.emailDraft &&
    reference.kind === 'message'
  ) {
    if (item.done)
      throw new TrackError('Reopen the item before adding a review.');
    // A draft has one original review, even when a brief mentions it again.
    if (
      listTracked(session).some(
        (other) =>
          other.id !== item.id &&
          other.followThrough?.reviews.some((review) =>
            isDeepStrictEqual(review.source, reference),
          ),
      )
    ) {
      throw new TrackError(
        'This draft already belongs to another tracked item.',
      );
    }
    const checked = normalizeEmailDraft(evidence.message.emailDraft);
    if (checked.error || !checked.draft)
      throw new TrackError(checked.error ?? 'Invalid email draft.');
    state.reviews.push({
      source: reference,
      draft: checked.draft,
      revision: 1,
      state: 'pending',
      deferred_until: null,
      decided_at: null,
    });
  }
  state.references.push(reference);
}

function reviewChange(
  session: Session,
  state: FollowThrough,
  body: Record<string, unknown>,
  now: Date,
) {
  const source = trackReference(body.source);
  trackEvidence(session, source);
  const review = state.reviews.find((review) =>
    isDeepStrictEqual(review.source, source),
  );
  if (!review || body.review_revision !== review.revision)
    throw new TrackError('Review changed. Refresh before deciding.');
  if (review.state === 'approved')
    throw new TrackError(
      'Already approved. Check the recorded action before considering another send.',
    );
  switch (body.decision) {
    case 'edit': {
      if (review.state === 'declined')
        throw new TrackError('Reopen the review before editing.');
      const checked = normalizeEmailDraft(body.draft);
      if (checked.error || !checked.draft)
        throw new TrackError(checked.error ?? 'Invalid email draft.');
      const { track_id: _trackId, ...edited } = checked.draft;
      review.draft = {
        ...edited,
        ...(review.draft.track_id ? { track_id: review.draft.track_id } : {}),
      };
      review.state = 'pending';
      review.deferred_until = null;
      break;
    }
    case 'defer': {
      if (review.state === 'declined')
        throw new TrackError('Reopen the review before deferring.');
      const at =
        typeof body.until === 'string' &&
        /(Z|[+-]\d{2}:\d{2})$/.test(body.until)
          ? Date.parse(body.until)
          : NaN;
      if (!Number.isFinite(at) || at <= now.getTime())
        throw new TrackError('Deferral needs a future date.');
      review.state = 'deferred';
      review.deferred_until = new Date(at).toISOString();
      break;
    }
    case 'approve':
      if (review.state === 'declined')
        throw new TrackError('Reopen the review before approving.');
      review.state = 'approved';
      review.deferred_until = null;
      break;
    case 'decline':
      review.state = 'declined';
      review.deferred_until = null;
      break;
    case 'reopen':
      review.state = 'pending';
      review.deferred_until = null;
      break;
    default:
      throw new TrackError('Expected edit, defer, approve, decline or reopen.');
  }
  review.revision += 1;
  review.decided_at = now.toISOString();
}

/** Synchronous read/check/write on the gateway; atomic file replacement survives restart. */
export function mutateFollowThrough(
  session: Session,
  id: number,
  body: Record<string, unknown>,
  actor: 'user' | 'agent',
  now = new Date(),
) {
  if (JSON.stringify(body).length > 35000)
    throw new TrackError('Follow-through change is too large.');
  const current = getTracked(session, id);
  const requestId = text(body.request_id, 100);
  const fingerprint = createHash('sha256')
    .update(stableStringify(body))
    .digest('hex');
  const retry = current.followThrough?.requests.find(
    (request) => request.id === requestId,
  );
  if (retry) {
    if (retry.fingerprint !== fingerprint)
      throw new TrackError(
        'Request id was already used for a different change.',
      );
    return { item: followThroughDetail(session, current), applied: false };
  }
  if (
    !Number.isSafeInteger(body.revision) ||
    body.revision !== (current.revision ?? 1)
  )
    throw new TrackError('Item changed. Refresh before saving.');
  const item = changeTracked(session, id, (item) => {
    const state =
      item.followThrough ??
      newFollowThrough(verifiedTrackOwner(session), session.id);
    if (state.requests.length >= 1000)
      throw new TrackError('This item has reached its change history limit.');
    switch (body.action) {
      case 'state': {
        if (item.done) throw new TrackError('Reopen the completed item first.');
        if (!TRACK_PHASES.includes(body.phase as TrackPhase))
          throw new TrackError(
            'Invalid phase. Completion requires user confirmation.',
          );
        appendTrackedNote(item, text(body.reason), actor, now);
        state.phase = body.phase as TrackPhase;
        break;
      }
      case 'link':
        link(session, item, state, body.reference);
        break;
      case 'contract': {
        if (item.done) throw new TrackError('Reopen the completed item first.');
        if (state.job?.attempts.length && actor !== 'user')
          throw new TrackError(
            'Only the user may change checks after verification begins.',
          );
        const contract = jobContract(body.checks, body.dependencies);
        assertDependencies(session, item, contract);
        contract.objective = item.outcome ?? item.title;
        contract.attemptLimit =
          state.job?.attemptLimit ?? MAX_VERIFICATION_ATTEMPTS;
        contract.attempts = state.job?.attempts ?? [];
        state.job = contract;
        break;
      }
      case 'retry_checks':
        if (
          actor !== 'user' ||
          item.done ||
          !state.job ||
          state.job.attempts.length < state.job.attemptLimit
        )
          throw new TrackError(
            'Only the user may authorize more checks after the repair limit.',
          );
        // User renewals retain every failed check; at most ten rounds per job.
        if (state.job.attemptLimit >= 21)
          throw new TrackError('Review this job before starting further work.');
        state.job.attemptLimit += MAX_VERIFICATION_ATTEMPTS - 1;
        state.phase = 'in_progress';
        break;
      case 'verify':
        if (item.done || !state.job)
          throw new TrackError('Define checks on an open item first.');
        if (state.job.objective !== (item.outcome ?? item.title))
          throw new TrackError(
            'The outcome changed. Review the acceptance checks first.',
          );
        verifyJob(
          session,
          state.job,
          (reference) => trackEvidence(session, reference),
          now,
        );
        state.phase = state.job.attempts
          .at(-1)
          ?.checks.every((check) => check.passed)
          ? 'needs_you'
          : state.job.attempts.length >= state.job.attemptLimit
            ? 'blocked'
            : 'in_progress';
        break;
      case 'complete':
        if (actor !== 'user' || typeof body.done !== 'boolean')
          throw new TrackError(
            'Only the user can confirm or reopen an outcome.',
          );
        setTrackedCompletion(session, item, body.done, actor, now);
        break;
      case 'review':
        if (actor !== 'user')
          throw new TrackError('Only the user can decide a review.');
        if (item.done) throw new TrackError('Reopen the completed item first.');
        reviewChange(session, state, body, now);
        break;
      default:
        throw new TrackError(
          'Expected state, link, contract, verify, review or complete.',
        );
    }
    state.requests.push({ id: requestId, fingerprint });
    item.followThrough = state;
  });
  return { item: followThroughDetail(session, item), applied: true };
}

/** Called only after a foreground reply or scheduled delivery has been stored. */
export function recordTrackedDraft(
  sessionId: string,
  messageId: number,
  workId?: string,
): void {
  const session = getSessionById(sessionId);
  const draft = getSessionAssistantMessage(sessionId, messageId)?.emailDraft;
  if (!session || !draft?.track_id) return;
  const work = workId ? readWork(workId) : null;
  if (
    work &&
    (work.sessionId !== session.id ||
      work.messageId !== messageId ||
      work.agentId !== session.agent_id)
  )
    throw new TrackError('Draft does not belong to this work.');
  const end = work
    ? beginTurnUser(
        session.id,
        work.owner,
        undefined,
        webNotificationSessionOperator(
          work.originSessionId ?? work.sessionId,
        ) ?? undefined,
      )
    : () => {};
  try {
    verifiedTrackOwner(session);
    const origin = work
      ? work.originSessionId
        ? getSessionById(work.originSessionId)
        : null
      : session;
    if (!origin || todoOwnerOf(origin) !== todoOwnerOf(session)) return;
    if (work?.trackedItem && work.trackedItem.id !== draft.track_id) return;
    const item = listTracked(session).find(
      (entry) => entry.id === draft.track_id,
    );
    // The user may complete or remove the item while a preparation is running.
    if (!item || item.done) return;
    const reference = {
      kind: 'message' as const,
      session_id: session.id,
      message_id: messageId,
    };
    if (
      item.followThrough?.references.some((entry) =>
        isDeepStrictEqual(entry, reference),
      )
    )
      return;
    mutateFollowThrough(
      session,
      item.id,
      {
        action: 'link',
        reference,
        revision: item.revision ?? 1,
        request_id: `draft:${messageId}`,
      },
      'agent',
    );
  } finally {
    end();
  }
}
