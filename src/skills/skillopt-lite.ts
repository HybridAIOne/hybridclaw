import type {
  SkillAmendmentProposalMetadata,
  SkillOptLiteApplyReport,
  SkillOptLiteEdit,
  SkillOptLiteEditOperation,
  SkillOptLiteEditSource,
  SkillOptLiteRejectedEditMemory,
} from './adaptive-skills-types.js';

const EDIT_OPERATIONS = new Set<SkillOptLiteEditOperation>([
  'append',
  'insert_after',
  'replace',
  'delete',
]);

function normalizeSourceType(value: unknown): SkillOptLiteEditSource {
  return value === 'success' ? 'success' : 'failure';
}

function normalizeEditOperation(
  value: unknown,
): SkillOptLiteEditOperation | null {
  return typeof value === 'string' &&
    EDIT_OPERATIONS.has(value as SkillOptLiteEditOperation)
    ? (value as SkillOptLiteEditOperation)
    : null;
}

function normalizeSupportCount(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.max(1, Math.floor(numeric));
}

export function normalizeSkillOptLiteEdits(raw: unknown): SkillOptLiteEdit[] {
  if (!Array.isArray(raw)) return [];
  const edits: SkillOptLiteEdit[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const op = normalizeEditOperation(record.op);
    if (!op) continue;
    const content = typeof record.content === 'string' ? record.content : '';
    const target = typeof record.target === 'string' ? record.target : '';
    const rationale =
      typeof record.rationale === 'string' ? record.rationale.trim() : '';
    edits.push({
      op,
      target,
      content,
      rationale,
      source_type: normalizeSourceType(record.source_type),
      support_count: normalizeSupportCount(record.support_count),
    });
  }
  return edits;
}

function editPriority(edit: SkillOptLiteEdit): number {
  const sourceWeight = edit.source_type === 'failure' ? 1_000 : 0;
  return sourceWeight + edit.support_count;
}

export function rankAndClipSkillOptLiteEdits(
  edits: SkillOptLiteEdit[],
  editBudget: number,
): SkillOptLiteEdit[] {
  const maxEdits = Math.max(1, Math.floor(editBudget));
  return [...edits]
    .sort((left, right) => editPriority(right) - editPriority(left))
    .slice(0, maxEdits);
}

export function filterRejectedSkillOptLiteEdits(
  edits: SkillOptLiteEdit[],
  rejectedEdits: SkillOptLiteRejectedEditMemory[],
): SkillOptLiteEdit[] {
  if (rejectedEdits.length === 0) return edits;
  const rejectedKeys = new Set(
    rejectedEdits.map((edit) =>
      [edit.op, edit.target.trim(), edit.content_preview.trim()].join('\0'),
    ),
  );
  return edits.filter((edit) => {
    const key = [
      edit.op,
      edit.target.trim(),
      edit.content.trim().slice(0, 200),
    ].join('\0');
    return !rejectedKeys.has(key);
  });
}

function preview(content: string): string {
  return content.trim().slice(0, 200);
}

function applyOneEdit(
  skillContent: string,
  edit: SkillOptLiteEdit,
  index: number,
): { content: string; report: SkillOptLiteApplyReport } {
  const baseReport = {
    index,
    op: edit.op,
    target: edit.target.slice(0, 200),
    content_preview: preview(edit.content),
    source_type: edit.source_type,
    support_count: edit.support_count,
  };

  if (edit.op !== 'delete' && !edit.content.trim()) {
    return {
      content: skillContent,
      report: {
        ...baseReport,
        status: 'skipped_empty_content',
      },
    };
  }

  if (edit.op === 'append') {
    return {
      content: `${skillContent.trimEnd()}\n\n${edit.content.trim()}\n`,
      report: { ...baseReport, status: 'applied_append' },
    };
  }

  if (edit.op === 'insert_after') {
    if (!edit.target.trim()) {
      return {
        content: `${skillContent.trimEnd()}\n\n${edit.content.trim()}\n`,
        report: {
          ...baseReport,
          status: 'applied_insert_after_fallback_append',
        },
      };
    }
    const targetIndex = skillContent.indexOf(edit.target);
    if (targetIndex < 0) {
      return {
        content: skillContent,
        report: { ...baseReport, status: 'skipped_target_not_found' },
      };
    }
    const afterTarget = targetIndex + edit.target.length;
    const nextNewline = skillContent.indexOf('\n', afterTarget);
    const insertAt = nextNewline >= 0 ? nextNewline + 1 : skillContent.length;
    return {
      content:
        skillContent.slice(0, insertAt) +
        `\n${edit.content.trim()}\n` +
        skillContent.slice(insertAt),
      report: { ...baseReport, status: 'applied_insert_after' },
    };
  }

  if (!edit.target.trim()) {
    return {
      content: skillContent,
      report: { ...baseReport, status: 'skipped_missing_target' },
    };
  }
  if (!skillContent.includes(edit.target)) {
    return {
      content: skillContent,
      report: { ...baseReport, status: 'skipped_target_not_found' },
    };
  }

  if (edit.op === 'replace') {
    return {
      content: skillContent.replace(edit.target, edit.content.trim()),
      report: { ...baseReport, status: 'applied_replace' },
    };
  }

  if (edit.op === 'delete') {
    return {
      content: skillContent.replace(edit.target, ''),
      report: { ...baseReport, status: 'applied_delete' },
    };
  }

  return {
    content: skillContent,
    report: { ...baseReport, status: 'skipped_unknown' },
  };
}

export function applySkillOptLiteEdits(
  originalContent: string,
  edits: SkillOptLiteEdit[],
): { content: string; report: SkillOptLiteApplyReport[] } {
  let content = originalContent;
  const report: SkillOptLiteApplyReport[] = [];
  for (const [index, edit] of edits.entries()) {
    const applied = applyOneEdit(content, edit, index + 1);
    content = applied.content;
    report.push(applied.report);
  }
  return { content, report };
}

export function gateSkillOptLiteCandidate(input: {
  originalContent: string;
  proposedContent: string;
  applyReport: SkillOptLiteApplyReport[];
  selectedEdits?: SkillOptLiteEdit[];
  heldOutEvidence?: Record<string, unknown>[];
  minScoreDelta?: number;
  validationDecision?: unknown;
}): NonNullable<SkillAmendmentProposalMetadata['gate']> {
  const normalizedDecision =
    input.validationDecision &&
    typeof input.validationDecision === 'object' &&
    !Array.isArray(input.validationDecision)
      ? (input.validationDecision as Record<string, unknown>)
      : null;
  if (normalizedDecision?.action === 'reject') {
    const reason =
      typeof normalizedDecision.reason === 'string'
        ? normalizedDecision.reason.trim()
        : '';
    return {
      accepted: false,
      reason: reason || 'Optimizer validation rejected the candidate.',
      ...scoreSkillOptLiteCandidate(input),
    };
  }

  const score = scoreSkillOptLiteCandidate(input);
  if (input.originalContent === input.proposedContent) {
    return {
      accepted: false,
      reason: 'Candidate does not change the skill document.',
      ...score,
    };
  }
  const appliedCount = input.applyReport.filter((entry) =>
    entry.status.startsWith('applied'),
  ).length;
  if (appliedCount === 0) {
    return {
      accepted: false,
      reason: 'No structured edits applied cleanly.',
      ...score,
    };
  }
  if (
    (score.held_out_failure_count ?? 0) > 0 &&
    typeof score.current_score === 'number' &&
    typeof score.candidate_score === 'number' &&
    score.candidate_score < score.current_score + (input.minScoreDelta ?? 0)
  ) {
    return {
      accepted: false,
      reason: `Candidate did not improve held-out score (${score.candidate_score.toFixed(2)} <= ${score.current_score.toFixed(2)}).`,
      ...score,
    };
  }
  if (
    (score.held_out_failure_count ?? 0) > 0 &&
    (score.matched_held_out_failures ?? 0) === 0
  ) {
    return {
      accepted: false,
      reason: 'Candidate edits do not cover any held-out failure evidence.',
      ...score,
    };
  }
  return {
    accepted: true,
    reason:
      typeof normalizedDecision?.reason === 'string'
        ? normalizedDecision.reason.trim() || 'Candidate passed local gate.'
        : 'Candidate passed local gate.',
    ...score,
  };
}

function evidenceOutcomeScore(evidence: Record<string, unknown>): number {
  if (evidence.outcome === 'success') return 1;
  if (evidence.outcome === 'partial') return 0.5;
  return 0;
}

const HELD_OUT_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'user',
  'skill',
  'request',
  'response',
  'error',
  'failure',
]);

function textTokens(value: unknown): Set<string> {
  const text =
    typeof value === 'string'
      ? value
      : value == null
        ? ''
        : JSON.stringify(value);
  return new Set(
    text
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_-]{2,}/g)
      ?.filter((token) => !HELD_OUT_STOP_WORDS.has(token)) ?? [],
  );
}

function heldOutEvidenceTokens(evidence: Record<string, unknown>): Set<string> {
  return textTokens([
    evidence.errorCategory,
    evidence.errorDetail,
    evidence.userFeedback,
    evidence.input,
    evidence.output,
    evidence.errors,
    evidence.tools,
  ]);
}

function editTokens(edit: SkillOptLiteEdit): Set<string> {
  return textTokens([edit.target, edit.content, edit.rationale]);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function scoreSkillOptLiteCandidate(input: {
  selectedEdits?: SkillOptLiteEdit[];
  heldOutEvidence?: Record<string, unknown>[];
}): Omit<
  NonNullable<SkillAmendmentProposalMetadata['gate']>,
  'accepted' | 'reason'
> {
  const heldOutEvidence = input.heldOutEvidence ?? [];
  if (heldOutEvidence.length === 0) {
    return {
      current_score: 0,
      candidate_score: 0.01,
      best_score: 0.01,
      held_out_count: 0,
      held_out_failure_count: 0,
      matched_held_out_failures: 0,
    };
  }

  const selectedEdits = input.selectedEdits ?? [];
  const failureEdits = selectedEdits.filter(
    (edit) => edit.source_type === 'failure',
  );
  const selectedEditTokens = new Set(
    failureEdits.flatMap((edit) => [...editTokens(edit)]),
  );
  let heldOutFailureCount = 0;
  let matchedHeldOutFailures = 0;
  for (const evidence of heldOutEvidence) {
    if (evidence.outcome === 'success') continue;
    heldOutFailureCount += 1;
    const tokens = heldOutEvidenceTokens(evidence);
    if ([...tokens].some((token) => selectedEditTokens.has(token))) {
      matchedHeldOutFailures += 1;
    }
  }

  const currentScore = average(heldOutEvidence.map(evidenceOutcomeScore));
  const coverage =
    heldOutFailureCount > 0 ? matchedHeldOutFailures / heldOutFailureCount : 1;
  const supportBoost = Math.min(
    0.2,
    failureEdits.reduce((sum, edit) => sum + edit.support_count, 0) / 100,
  );
  const candidateScore = Math.min(
    1,
    currentScore +
      (heldOutFailureCount > 0 ? coverage * 0.25 : 0.01) +
      supportBoost,
  );
  return {
    current_score: Number(currentScore.toFixed(4)),
    candidate_score: Number(candidateScore.toFixed(4)),
    best_score: Number(Math.max(currentScore, candidateScore).toFixed(4)),
    held_out_count: heldOutEvidence.length,
    held_out_failure_count: heldOutFailureCount,
    matched_held_out_failures: matchedHeldOutFailures,
  };
}

export function buildSkillOptLiteMetadata(input: {
  editBudget: number;
  evidence: NonNullable<SkillAmendmentProposalMetadata['evidence']>;
  edits: SkillOptLiteEdit[];
  selectedEdits: SkillOptLiteEdit[];
  applyReport: SkillOptLiteApplyReport[];
  gate: NonNullable<SkillAmendmentProposalMetadata['gate']>;
  rejectedEditCount?: number;
}): SkillAmendmentProposalMetadata {
  return {
    kind: 'skillopt_lite',
    edit_budget: input.editBudget,
    evidence: input.evidence,
    edits: input.edits,
    selected_edits: input.selectedEdits,
    apply_report: input.applyReport,
    gate: input.gate,
    rejected_edit_count: input.rejectedEditCount,
  };
}
