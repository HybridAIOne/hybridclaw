export const DISTILL_STAGE_ORDER = [
  'ingest',
  'analyse',
  'build',
  'merge',
  'correct',
];

/** Source kinds an operator may pick; `correction` is recorded internally. */
export const DISTILL_SOURCE_KINDS = [
  'auto',
  'slack-export',
  'email-mbox',
  'transcript',
  'chat-jsonl',
  'markdown',
  'text',
  'interview',
];

export const PERSONA_DIMENSIONS = [
  'identity',
  'expression',
  'decision-making',
  'interpersonal',
  'experience',
  'correction',
];

export class DistillBlockedError extends Error {
  remediation;

  constructor(message, remediation) {
    super(message);
    this.name = 'DistillBlockedError';
    this.remediation = remediation;
  }
}
