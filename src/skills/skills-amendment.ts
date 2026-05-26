import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../agent/agent.js';
import { buildConversationContext } from '../agent/conversation.js';
import { resolveAgentForRequest } from '../agents/agent-registry.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { HYBRIDAI_CHATBOT_ID } from '../config/config.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import {
  createSkillAmendment,
  getLatestSkillAmendment,
  getSkillAmendmentById,
  getSkillObservations,
  getSkillOptLiteRejectedEdits,
  recordSkillOptLiteRejectedEdits,
  updateAmendmentStatus,
} from '../memory/db.js';
import { memoryService } from '../memory/memory-service.js';
import { modelRequiresChatbotId } from '../providers/factory.js';
import { adaptiveSkillsSessionId } from './adaptive-skills-session.js';
import type {
  SkillAmendment,
  SkillAmendmentProposalMetadata,
  SkillAmendmentStatus,
  SkillHealthMetrics,
  SkillObservation,
} from './adaptive-skills-types.js';
import {
  getSkillRunTrajectories,
  type SkillRunTrajectoryRecord,
} from './skill-run-trajectories.js';
import {
  applySkillOptLiteEdits,
  buildSkillOptLiteMetadata,
  filterRejectedSkillOptLiteEdits,
  gateSkillOptLiteCandidate,
  normalizeSkillOptLiteEdits,
  rankAndClipSkillOptLiteEdits,
} from './skillopt-lite.js';
import { loadSkillCatalog } from './skills.js';
import { scanSkillContent } from './skills-guard.js';

const AMENDMENT_ALLOWED_TOOLS = ['read', 'grep', 'glob'];

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function resolveSkillCatalogEntry(skillName: string) {
  const normalized = skillName.trim().toLowerCase();
  const match = loadSkillCatalog().find(
    (skill) => skill.name.trim().toLowerCase() === normalized,
  );
  if (!match) {
    throw new Error(`Skill "${skillName}" was not found.`);
  }
  return match;
}

function buildDiffSummary(
  originalContent: string,
  proposedContent: string,
): string {
  if (originalContent === proposedContent) {
    return 'No changes.';
  }
  const originalLineCount = originalContent.split('\n').length;
  const proposedLineCount = proposedContent.split('\n').length;
  return `${proposedLineCount} line(s) (was ${originalLineCount}).`;
}

function extractJsonObject(text: string): Record<string, unknown> {
  let trimmed = text.trim();
  const fencedJsonMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fencedJsonMatch?.[1]) {
    trimmed = fencedJsonMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to the uniform error below
  }

  throw new Error('Skill amendment proposal did not return valid JSON.');
}

function parseProposalOutput(text: string): {
  rationale: string;
  content: string;
  metadata: SkillAmendmentProposalMetadata | null;
} {
  const parsed = extractJsonObject(text);
  const rationale =
    typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '';
  const content = typeof parsed.content === 'string' ? parsed.content : '';
  if (!rationale) {
    throw new Error('Skill amendment proposal missing `rationale`.');
  }
  if (!content.trim()) {
    throw new Error('Skill amendment proposal missing `content`.');
  }
  return {
    rationale,
    content,
    metadata: { kind: 'full_content' },
  };
}

function parseSkillOptLiteProposalOutput(input: {
  text: string;
  originalContent: string;
  metadataEvidence: NonNullable<SkillAmendmentProposalMetadata['evidence']>;
  heldOutEvidence: Record<string, unknown>[];
  editBudget: number;
  minCandidateScoreDelta: number;
  rejectedEdits: ReturnType<typeof getSkillOptLiteRejectedEdits>;
}): {
  rationale: string;
  content: string;
  metadata: SkillAmendmentProposalMetadata;
} {
  const parsed = extractJsonObject(input.text);
  const rationale =
    typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '';
  if (!rationale) {
    throw new Error('SkillOpt-lite proposal missing `rationale`.');
  }

  const directEdits = normalizeSkillOptLiteEdits(parsed.edits);
  const failureEdits = normalizeSkillOptLiteEdits(parsed.failure_edits).map(
    (edit) => ({ ...edit, source_type: 'failure' as const }),
  );
  const successEdits = normalizeSkillOptLiteEdits(parsed.success_edits).map(
    (edit) => ({ ...edit, source_type: 'success' as const }),
  );
  const edits =
    directEdits.length > 0 ? directEdits : [...failureEdits, ...successEdits];
  if (edits.length === 0) {
    throw new Error('SkillOpt-lite proposal did not include usable edits.');
  }

  const eligibleEdits = filterRejectedSkillOptLiteEdits(
    edits,
    input.rejectedEdits,
  );
  if (eligibleEdits.length === 0) {
    throw new Error('SkillOpt-lite proposal only repeated rejected edits.');
  }
  const selectedEdits = rankAndClipSkillOptLiteEdits(
    eligibleEdits,
    input.editBudget,
  );
  const applied = applySkillOptLiteEdits(input.originalContent, selectedEdits);
  const gate = gateSkillOptLiteCandidate({
    originalContent: input.originalContent,
    proposedContent: applied.content,
    applyReport: applied.report,
    selectedEdits,
    heldOutEvidence: input.heldOutEvidence,
    minScoreDelta: input.minCandidateScoreDelta,
    validationDecision: parsed.validation,
  });
  const metadata = buildSkillOptLiteMetadata({
    editBudget: input.editBudget,
    evidence: input.metadataEvidence,
    edits,
    selectedEdits,
    applyReport: applied.report,
    gate,
    rejectedEditCount: input.rejectedEdits.length,
  });
  return {
    rationale,
    content: applied.content,
    metadata,
  };
}

async function resolveCogneeRuntime(agentId: string, skillName: string) {
  const sessionId = adaptiveSkillsSessionId(skillName);
  const session = memoryService.getOrCreateSession(
    sessionId,
    null,
    'adaptive-skills',
    agentId,
  );
  const resolvedRuntime = resolveAgentForRequest({
    agentId,
    session,
  });
  const model = resolvedRuntime.model;
  const chatbotId = modelRequiresChatbotId(model)
    ? resolvedRuntime.chatbotId || HYBRIDAI_CHATBOT_ID || agentId
    : resolvedRuntime.chatbotId;
  const enableRag = session.enable_rag !== 0;
  const { messages } = buildConversationContext({
    agentId: resolvedRuntime.agentId,
    sessionSummary: null,
    history: [],
    currentUserContent: '',
    runtimeInfo: {
      chatbotId,
      model,
      defaultModel: model,
      channelType: 'adaptive-skills',
      channelId: 'adaptive-skills',
      guildId: null,
      workspacePath: path.dirname(resolveSkillCatalogEntry(skillName).filePath),
    },
    allowedTools: AMENDMENT_ALLOWED_TOOLS,
  });
  return {
    sessionId,
    messages,
    chatbotId,
    enableRag,
    model,
    resolvedAgentId: resolvedRuntime.agentId,
  };
}

function compactObservation(
  observation: SkillObservation,
): Record<string, unknown> {
  return {
    outcome: observation.outcome,
    errorCategory: observation.error_category,
    errorDetail: observation.error_detail,
    userFeedback: observation.user_feedback,
    createdAt: observation.created_at,
  };
}

function splitHeldOut<T>(
  items: T[],
  heldOutRatio: number,
): {
  training: T[];
  heldOut: T[];
} {
  if (items.length <= 1 || heldOutRatio <= 0) {
    return { training: items, heldOut: [] };
  }
  const heldOutCount = Math.min(
    items.length - 1,
    Math.max(1, Math.floor(items.length * heldOutRatio)),
  );
  return {
    heldOut: items.slice(0, heldOutCount),
    training: items.slice(heldOutCount),
  };
}

function compactTrajectory(
  record: SkillRunTrajectoryRecord,
): Record<string, unknown> {
  return {
    outcome: record.outcome,
    score: record.score,
    input: record.input?.content ?? null,
    output: record.output?.content ?? null,
    errors: record.event.errors,
    tools: record.tools_used.map((tool) => ({
      name: tool.name,
      isError: tool.is_error,
      blocked: tool.blocked,
      result: tool.result?.content ?? null,
    })),
    capturedAt: record.captured_at,
  };
}

function buildSkillOptEvidence(input: { skillName: string; agentId: string }): {
  evidence: NonNullable<SkillAmendmentProposalMetadata['evidence']>;
  training: Record<string, unknown>[];
  failureTraining: Record<string, unknown>[];
  successTraining: Record<string, unknown>[];
  heldOut: Record<string, unknown>[];
} {
  const config = getRuntimeConfig().adaptiveSkills.optimization;
  const trajectories = getSkillRunTrajectories({
    skillName: input.skillName,
    agentId: input.agentId,
    limit: config.maxEvidenceExamples,
    seed: `${config.trajectorySampleSeed}:${input.skillName}:${input.agentId}`,
  });
  if (trajectories.length >= config.minTrajectoryEvidence) {
    const split = splitHeldOut(trajectories, config.heldOutRatio);
    const training = split.training.map(compactTrajectory);
    return {
      evidence: {
        trajectory_count: trajectories.length,
        observation_count: 0,
        training_count: split.training.length,
        held_out_count: split.heldOut.length,
        source: 'trajectories',
      },
      training,
      failureTraining: training.filter((entry) => entry.outcome !== 'success'),
      successTraining: training.filter((entry) => entry.outcome === 'success'),
      heldOut: split.heldOut.map(compactTrajectory),
    };
  }

  const observations = getSkillObservations({
    skillName: input.skillName,
    limit: config.maxEvidenceExamples,
  });
  const split = splitHeldOut(observations, config.heldOutRatio);
  const training = split.training.map(compactObservation);
  return {
    evidence: {
      trajectory_count: trajectories.length,
      observation_count: observations.length,
      training_count: split.training.length,
      held_out_count: split.heldOut.length,
      source: 'observations',
    },
    training,
    failureTraining: training.filter((entry) => entry.outcome !== 'success'),
    successTraining: training.filter((entry) => entry.outcome === 'success'),
    heldOut: split.heldOut.map(compactObservation),
  };
}

function buildSkillOptLitePrompt(input: {
  skillName: string;
  skillFilePath: string;
  metrics: SkillHealthMetrics;
  originalContent: string;
  failureEvidence: Record<string, unknown>[];
  successEvidence: Record<string, unknown>[];
  heldOutEvidence: Record<string, unknown>[];
  rejectedEditMemory: ReturnType<typeof getSkillOptLiteRejectedEdits>;
  editBudget: number;
}): string {
  return [
    'You are improving a HybridClaw SKILL.md file using a SkillOpt-lite amendment loop.',
    'Treat the skill document as the trainable artifact. Do not rewrite the whole file.',
    'Run two reflection passes internally: a failure analyst proposes fixes, then a success analyst removes edits that would regress successful behavior.',
    'Failure-driven edits have priority, but successful examples are preservation constraints.',
    'Do not repeat rejected edit memory unless the held-out evidence clearly changed.',
    `Return JSON only with this exact shape: {"rationale":"...","validation":{"action":"accept|reject","reason":"..."},"edits":[{"op":"append|insert_after|replace|delete","target":"exact existing text for insert_after/replace/delete, empty only for append","content":"new text, empty for delete","rationale":"...","source_type":"failure|success","support_count":1}]}.`,
    'You may also return `failure_edits` and `success_edits` instead of `edits`; they will be merged failure-first.',
    `Use at most ${input.editBudget} high-impact edits. Prefer append or insert_after for clarifications; use replace/delete only when the target text is clearly harmful.`,
    '',
    `Skill name: ${input.skillName}`,
    `Current file path: ${input.skillFilePath}`,
    '',
    'Health metrics:',
    JSON.stringify(input.metrics, null, 2),
    '',
    'Failure analyst training evidence:',
    JSON.stringify(input.failureEvidence, null, 2),
    '',
    'Success analyst preservation evidence:',
    JSON.stringify(input.successEvidence, null, 2),
    '',
    'Held-out evidence for candidate validation:',
    JSON.stringify(input.heldOutEvidence, null, 2),
    '',
    'Rejected edit memory to avoid retrying:',
    JSON.stringify(input.rejectedEditMemory, null, 2),
    '',
    'Current SKILL.md:',
    input.originalContent,
  ].join('\n');
}

export async function proposeAmendment(input: {
  skillName: string;
  metrics: SkillHealthMetrics;
  agentId: string;
}): Promise<SkillAmendment> {
  const skill = resolveSkillCatalogEntry(input.skillName);
  const originalContent = fs.readFileSync(skill.filePath, 'utf-8');
  const optimizationConfig = getRuntimeConfig().adaptiveSkills.optimization;
  const evidence = buildSkillOptEvidence({
    skillName: skill.name,
    agentId: input.agentId,
  });
  const rejectedEditMemory = getSkillOptLiteRejectedEdits({
    skillName: skill.name,
    limit: optimizationConfig.rejectedEditMemoryLimit,
  });

  const proposalPrompt = buildSkillOptLitePrompt({
    skillName: skill.name,
    skillFilePath: skill.filePath,
    metrics: input.metrics,
    originalContent,
    failureEvidence: evidence.failureTraining,
    successEvidence: evidence.successTraining,
    heldOutEvidence: evidence.heldOut,
    rejectedEditMemory,
    editBudget: optimizationConfig.editBudget,
  });

  const runtime = await resolveCogneeRuntime(input.agentId, skill.name);
  recordAuditEvent({
    sessionId: runtime.sessionId,
    runId: makeAuditRunId('skill-amendment'),
    event: {
      type: 'skill.amendment.reflection_started',
      skillName: skill.name,
      evidence: evidence.evidence,
      editBudget: optimizationConfig.editBudget,
    },
  });
  const output = await runAgent({
    sessionId: runtime.sessionId,
    messages: [...runtime.messages, { role: 'user', content: proposalPrompt }],
    chatbotId: runtime.chatbotId,
    enableRag: runtime.enableRag,
    model: runtime.model,
    agentId: runtime.resolvedAgentId,
    channelId: 'adaptive-skills',
    allowedTools: AMENDMENT_ALLOWED_TOOLS,
  });
  if (output.status === 'error' || !output.result?.trim()) {
    throw new Error(output.error || 'Skill amendment proposal failed.');
  }

  let proposal: {
    rationale: string;
    content: string;
    metadata: SkillAmendmentProposalMetadata | null;
  };
  try {
    proposal = parseSkillOptLiteProposalOutput({
      text: output.result,
      originalContent,
      metadataEvidence: evidence.evidence,
      heldOutEvidence: evidence.heldOut,
      editBudget: optimizationConfig.editBudget,
      minCandidateScoreDelta: optimizationConfig.minCandidateScoreDelta,
      rejectedEdits: rejectedEditMemory,
    });
    if (proposal.metadata?.gate) {
      recordAuditEvent({
        sessionId: runtime.sessionId,
        runId: makeAuditRunId('skill-amendment'),
        event: {
          type: 'skill.amendment.gate',
          skillName: skill.name,
          accepted: proposal.metadata.gate.accepted,
          reason: proposal.metadata.gate.reason,
          proposalKind: proposal.metadata.kind,
          evidence: evidence.evidence,
        },
      });
    }
    if (proposal.metadata?.gate && !proposal.metadata.gate.accepted) {
      const written = recordSkillOptLiteRejectedEdits({
        skillName: skill.name,
        edits: proposal.metadata.selected_edits ?? [],
        reason: proposal.metadata.gate.reason,
        evidenceSource: evidence.evidence.source,
      });
      recordAuditEvent({
        sessionId: runtime.sessionId,
        runId: makeAuditRunId('skill-amendment'),
        event: {
          type: 'skill.amendment.rejected_edit_memory',
          skillName: skill.name,
          rejectedEditCount: written,
          reason: proposal.metadata.gate.reason,
        },
      });
      throw new Error(
        `SkillOpt-lite candidate rejected: ${proposal.metadata.gate.reason}`,
      );
    }
  } catch (error) {
    if (
      output.result.includes('"edits"') ||
      output.result.includes('"failure_edits"') ||
      output.result.includes('"success_edits"')
    ) {
      recordAuditEvent({
        sessionId: runtime.sessionId,
        runId: makeAuditRunId('skill-amendment'),
        event: {
          type: 'skill.amendment.gate',
          skillName: skill.name,
          accepted: false,
          reason: error instanceof Error ? error.message : String(error),
          proposalKind: 'skillopt_lite',
          evidence: evidence.evidence,
        },
      });
      throw error;
    }
    const legacyProposal = parseProposalOutput(output.result);
    proposal = {
      ...legacyProposal,
      metadata: {
        kind: 'full_content',
        evidence: evidence.evidence,
      },
    };
    recordAuditEvent({
      sessionId: runtime.sessionId,
      runId: makeAuditRunId('skill-amendment'),
      event: {
        type: 'skill.amendment.skillopt_lite_fallback',
        skillName: skill.name,
        reason: error instanceof Error ? error.message : String(error),
      },
    });
  }
  const scan = scanSkillContent({
    skillName: skill.name,
    skillPath: skill.filePath,
    sourceTag: String(skill.source),
    content: proposal.content,
    fileName: path.basename(skill.filePath),
  });
  const previous = getLatestSkillAmendment({ skillName: skill.name });
  const amendment = createSkillAmendment({
    skillName: skill.name,
    skillFilePath: skill.filePath,
    previousVersion: previous?.version || null,
    status: 'staged',
    originalContent,
    proposedContent: proposal.content,
    originalContentHash: sha256(originalContent),
    proposedContentHash: sha256(proposal.content),
    rationale: proposal.rationale,
    diffSummary: buildDiffSummary(originalContent, proposal.content),
    proposedBy: input.agentId,
    guardVerdict: scan.verdict,
    guardFindingsCount: scan.findings.length,
    metricsAtProposal: input.metrics,
    proposalMetadata: proposal.metadata,
  });

  recordAuditEvent({
    sessionId: runtime.sessionId,
    runId: makeAuditRunId('skill-amendment'),
    event: {
      type: 'skill.amendment.proposed',
      skillName: skill.name,
      amendmentId: amendment.id,
      version: amendment.version,
      guardVerdict: amendment.guard_verdict,
      guardFindingsCount: amendment.guard_findings_count,
      proposedBy: amendment.proposed_by,
      proposalKind: amendment.proposal_metadata?.kind || 'unknown',
    },
  });

  return amendment;
}

export function requireAmendmentInStatus(input: {
  amendmentId: number;
  status: SkillAmendmentStatus;
  failureReason: string;
}): { ok: true; amendment: SkillAmendment } | { ok: false; reason: string } {
  const amendment = getSkillAmendmentById(input.amendmentId);
  if (!amendment) {
    return { ok: false, reason: 'Amendment not found.' };
  }
  if (amendment.status !== input.status) {
    return { ok: false, reason: input.failureReason };
  }
  return { ok: true, amendment };
}

export async function applyAmendment(input: {
  amendmentId: number;
  reviewedBy: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const required = requireAmendmentInStatus({
    amendmentId: input.amendmentId,
    status: 'staged',
    failureReason: 'Only staged amendments can be applied.',
  });
  if (!required.ok) {
    return required;
  }
  const { amendment } = required;

  const currentContent = fs.readFileSync(amendment.skill_file_path, 'utf-8');
  if (sha256(currentContent) !== amendment.original_content_hash) {
    return {
      ok: false,
      reason: 'Skill file changed since the amendment was proposed.',
    };
  }

  fs.writeFileSync(
    amendment.skill_file_path,
    amendment.proposed_content,
    'utf-8',
  );
  updateAmendmentStatus({
    amendmentId: amendment.id,
    status: 'applied',
    reviewedBy: input.reviewedBy,
    resetRunsSinceApply: true,
  });
  recordAuditEvent({
    sessionId: adaptiveSkillsSessionId(amendment.skill_name),
    runId: makeAuditRunId('skill-amendment'),
    event: {
      type: 'skill.amendment.applied',
      skillName: amendment.skill_name,
      amendmentId: amendment.id,
      version: amendment.version,
      reviewedBy: input.reviewedBy,
    },
  });
  return { ok: true };
}

export function rejectAmendment(input: {
  amendmentId: number;
  reviewedBy: string;
}): { ok: boolean; reason?: string } {
  const required = requireAmendmentInStatus({
    amendmentId: input.amendmentId,
    status: 'staged',
    failureReason: 'Only staged amendments can be rejected.',
  });
  if (!required.ok) {
    return required;
  }
  const { amendment } = required;

  updateAmendmentStatus({
    amendmentId: amendment.id,
    status: 'rejected',
    reviewedBy: input.reviewedBy,
  });
  recordAuditEvent({
    sessionId: adaptiveSkillsSessionId(amendment.skill_name),
    runId: makeAuditRunId('skill-amendment'),
    event: {
      type: 'skill.amendment.rejected',
      skillName: amendment.skill_name,
      amendmentId: amendment.id,
      version: amendment.version,
      reviewedBy: input.reviewedBy,
    },
  });
  return { ok: true };
}
