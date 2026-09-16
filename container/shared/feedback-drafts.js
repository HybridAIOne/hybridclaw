/**
 * Feedback drafts — the vocabulary shared by the container-side
 * `report_feedback` tool and the gateway that stores, reviews and submits
 * drafts. Keep this file dependency-free: it ships inside the container image
 * and is imported by the gateway.
 */

export const FEEDBACK_DRAFT_TYPES = ['bug', 'idea', 'missing_capability'];

export const FEEDBACK_DRAFT_TRIGGERS = [
  'tool_error',
  'user_frustration',
  'missing_capability',
  'model_judgment',
  'operator_request',
];

export const FEEDBACK_DRAFT_FAILURE_MODES = [
  'instruction_following',
  'destructive_actions',
  'code_quality',
  'repetition_and_looping',
  'model_regression',
  'overconfidence_and_hallucination',
  'context_and_memory',
  'overeager',
  'over_correction',
  'stopping_short',
  'dispute_or_decline',
  'subagent_overspawn',
  'tone_or_preachiness',
  'excessive_questions',
  'unwanted_scope',
  'other',
];

export const FEEDBACK_DRAFT_TASK_CATEGORIES = [
  'chat',
  'code_edit',
  'debug',
  'explain',
  'plan',
  'shell',
  'search',
  'review',
  'data_analysis',
  'communication',
  'other',
];

export const FEEDBACK_DRAFT_STATUSES = [
  'queued',
  'submitted',
  'discarded',
  'expired',
];

export const FEEDBACK_DRAFT_TITLE_MAX_CHARS = 200;
export const FEEDBACK_DRAFT_DETAILS_MAX_CHARS = 8_000;
export const FEEDBACK_DRAFT_AREA_MAX_CHARS = 64;
/** Unsent drafts expire after this many days. */
export const FEEDBACK_DRAFT_RETENTION_DAYS = 30;
/** Hard cap on queued drafts per session so a looping agent cannot flood it. */
export const FEEDBACK_DRAFT_MAX_QUEUED_PER_SESSION = 10;

export const FEEDBACK_DRAFT_ID_PATTERN = /^fbd_[0-9a-f]{10}$/;
export const REPORT_FEEDBACK_TOOL_NAME = 'report_feedback';

function isOneOf(values, value) {
  return typeof value === 'string' && values.includes(value);
}

export function isFeedbackDraftType(value) {
  return isOneOf(FEEDBACK_DRAFT_TYPES, value);
}

export function isFeedbackDraftTrigger(value) {
  return isOneOf(FEEDBACK_DRAFT_TRIGGERS, value);
}

export function isFeedbackDraftFailureMode(value) {
  return isOneOf(FEEDBACK_DRAFT_FAILURE_MODES, value);
}

export function isFeedbackDraftTaskCategory(value) {
  return isOneOf(FEEDBACK_DRAFT_TASK_CATEGORIES, value);
}

export function isFeedbackDraftStatus(value) {
  return isOneOf(FEEDBACK_DRAFT_STATUSES, value);
}

/**
 * Validate and normalise raw tool arguments. Shared by the container tool
 * (so the model gets an immediate, specific error) and the gateway route
 * (so a forged request cannot bypass the same rules).
 */
export function validateFeedbackDraftInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Feedback draft must be an object.' };
  }
  const args = raw;

  if (!isFeedbackDraftType(args.type)) {
    return {
      ok: false,
      error: `\`type\` must be one of: ${FEEDBACK_DRAFT_TYPES.join(', ')}.`,
    };
  }

  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) return { ok: false, error: '`title` is required.' };
  if (title.length > FEEDBACK_DRAFT_TITLE_MAX_CHARS) {
    return {
      ok: false,
      error: `\`title\` must be at most ${FEEDBACK_DRAFT_TITLE_MAX_CHARS} characters.`,
    };
  }

  const details = typeof args.details === 'string' ? args.details.trim() : '';
  if (!details) return { ok: false, error: '`details` is required.' };
  if (details.length > FEEDBACK_DRAFT_DETAILS_MAX_CHARS) {
    return {
      ok: false,
      error: `\`details\` must be at most ${FEEDBACK_DRAFT_DETAILS_MAX_CHARS} characters.`,
    };
  }

  const area = typeof args.area === 'string' ? args.area.trim() : '';
  if (area.length > FEEDBACK_DRAFT_AREA_MAX_CHARS) {
    return {
      ok: false,
      error: `\`area\` must be at most ${FEEDBACK_DRAFT_AREA_MAX_CHARS} characters.`,
    };
  }

  if (args.trigger !== undefined && !isFeedbackDraftTrigger(args.trigger)) {
    return {
      ok: false,
      error: `\`trigger\` must be one of: ${FEEDBACK_DRAFT_TRIGGERS.join(', ')}.`,
    };
  }
  if (
    args.failure_mode !== undefined &&
    !isFeedbackDraftFailureMode(args.failure_mode)
  ) {
    return {
      ok: false,
      error: `\`failure_mode\` must be one of: ${FEEDBACK_DRAFT_FAILURE_MODES.join(', ')}.`,
    };
  }
  if (
    args.task_category !== undefined &&
    !isFeedbackDraftTaskCategory(args.task_category)
  ) {
    return {
      ok: false,
      error: `\`task_category\` must be one of: ${FEEDBACK_DRAFT_TASK_CATEGORIES.join(', ')}.`,
    };
  }

  return {
    ok: true,
    value: {
      type: args.type,
      title,
      details,
      trigger: args.trigger ?? 'model_judgment',
      ...(area ? { area } : {}),
      ...(args.failure_mode ? { failure_mode: args.failure_mode } : {}),
      ...(args.task_category ? { task_category: args.task_category } : {}),
    },
  };
}
