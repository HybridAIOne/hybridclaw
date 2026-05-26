import type {
  SkillAmendmentProposalMetadata,
  SkillOptLiteApplyReport,
  SkillOptLiteEdit,
  SkillOptLiteEditOperation,
  SkillOptLiteEditSource,
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
  validationDecision?: unknown;
}): { accepted: boolean; reason: string } {
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
    };
  }

  if (input.originalContent === input.proposedContent) {
    return {
      accepted: false,
      reason: 'Candidate does not change the skill document.',
    };
  }
  const appliedCount = input.applyReport.filter((entry) =>
    entry.status.startsWith('applied'),
  ).length;
  if (appliedCount === 0) {
    return {
      accepted: false,
      reason: 'No structured edits applied cleanly.',
    };
  }
  return {
    accepted: true,
    reason:
      typeof normalizedDecision?.reason === 'string'
        ? normalizedDecision.reason.trim() || 'Candidate passed local gate.'
        : 'Candidate passed local gate.',
  };
}

export function buildSkillOptLiteMetadata(input: {
  editBudget: number;
  evidence: NonNullable<SkillAmendmentProposalMetadata['evidence']>;
  edits: SkillOptLiteEdit[];
  selectedEdits: SkillOptLiteEdit[];
  applyReport: SkillOptLiteApplyReport[];
  gate: NonNullable<SkillAmendmentProposalMetadata['gate']>;
}): SkillAmendmentProposalMetadata {
  return {
    kind: 'skillopt_lite',
    edit_budget: input.editBudget,
    evidence: input.evidence,
    edits: input.edits,
    selected_edits: input.selectedEdits,
    apply_report: input.applyReport,
    gate: input.gate,
  };
}
