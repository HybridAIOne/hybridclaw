export type FeedbackDraftType = 'bug' | 'idea' | 'missing_capability';
export type FeedbackDraftTrigger =
  | 'tool_error'
  | 'user_frustration'
  | 'missing_capability'
  | 'model_judgment'
  | 'operator_request';
export type FeedbackDraftFailureMode =
  | 'instruction_following'
  | 'destructive_actions'
  | 'code_quality'
  | 'repetition_and_looping'
  | 'model_regression'
  | 'overconfidence_and_hallucination'
  | 'context_and_memory'
  | 'overeager'
  | 'over_correction'
  | 'stopping_short'
  | 'dispute_or_decline'
  | 'subagent_overspawn'
  | 'tone_or_preachiness'
  | 'excessive_questions'
  | 'unwanted_scope'
  | 'other';
export type FeedbackDraftTaskCategory =
  | 'chat'
  | 'code_edit'
  | 'debug'
  | 'explain'
  | 'plan'
  | 'shell'
  | 'search'
  | 'review'
  | 'data_analysis'
  | 'communication'
  | 'other';
export type FeedbackDraftStatus =
  | 'queued'
  | 'submitted'
  | 'discarded'
  | 'expired';

export const FEEDBACK_DRAFT_TYPES: readonly FeedbackDraftType[];
export const FEEDBACK_DRAFT_TRIGGERS: readonly FeedbackDraftTrigger[];
export const FEEDBACK_DRAFT_FAILURE_MODES: readonly FeedbackDraftFailureMode[];
export const FEEDBACK_DRAFT_TASK_CATEGORIES: readonly FeedbackDraftTaskCategory[];
export const FEEDBACK_DRAFT_STATUSES: readonly FeedbackDraftStatus[];

export const FEEDBACK_DRAFT_TITLE_MAX_CHARS: number;
export const FEEDBACK_DRAFT_DETAILS_MAX_CHARS: number;
export const FEEDBACK_DRAFT_AREA_MAX_CHARS: number;
export const FEEDBACK_DRAFT_RETENTION_DAYS: number;
export const FEEDBACK_DRAFT_MAX_QUEUED_PER_SESSION: number;
export const FEEDBACK_DRAFT_ID_PATTERN: RegExp;
export const REPORT_FEEDBACK_TOOL_NAME: 'report_feedback';

export interface FeedbackDraftInput {
  type: FeedbackDraftType;
  title: string;
  details: string;
  area?: string;
  trigger?: FeedbackDraftTrigger;
  failure_mode?: FeedbackDraftFailureMode;
  task_category?: FeedbackDraftTaskCategory;
}

export interface ValidatedFeedbackDraftInput {
  type: FeedbackDraftType;
  title: string;
  details: string;
  trigger: FeedbackDraftTrigger;
  area?: string;
  failure_mode?: FeedbackDraftFailureMode;
  task_category?: FeedbackDraftTaskCategory;
}

export type FeedbackDraftValidationResult =
  | { ok: true; value: ValidatedFeedbackDraftInput }
  | { ok: false; error: string };

export function isFeedbackDraftType(value: unknown): value is FeedbackDraftType;
export function isFeedbackDraftTrigger(
  value: unknown,
): value is FeedbackDraftTrigger;
export function isFeedbackDraftFailureMode(
  value: unknown,
): value is FeedbackDraftFailureMode;
export function isFeedbackDraftTaskCategory(
  value: unknown,
): value is FeedbackDraftTaskCategory;
export function isFeedbackDraftStatus(
  value: unknown,
): value is FeedbackDraftStatus;
export function validateFeedbackDraftInput(
  raw: unknown,
): FeedbackDraftValidationResult;
