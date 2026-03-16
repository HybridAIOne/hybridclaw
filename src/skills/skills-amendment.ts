import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildConversationContext } from '../agent/conversation.js';
import { runAgent } from '../agent/agent.js';
import { resolveAgentForRequest } from '../agents/agent-registry.js';
import {
  makeAuditRunId,
  recordAuditEvent,
} from '../audit/audit-events.js';
import { HYBRIDAI_CHATBOT_ID } from '../config/config.js';
import {
  createSkillAmendment,
  getLatestSkillAmendment,
  getSkillAmendmentById,
  getSkillObservations,
  updateAmendmentStatus,
} from '../memory/db.js';
import { memoryService } from '../memory/memory-service.js';
import { modelRequiresChatbotId } from '../providers/factory.js';
import { scanSkillContent } from './skills-guard.js';
import { loadSkillCatalog } from './skills.js';
import type {
  SkillAmendment,
  SkillHealthMetrics,
} from './skills-cognee-types.js';

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

function buildDiffSummary(originalContent: string, proposedContent: string): string {
  if (originalContent === proposedContent) {
    return 'No material content changes.';
  }
  const originalLines = originalContent.split('\n');
  const proposedLines = proposedContent.split('\n');
  const maxLines = Math.max(originalLines.length, proposedLines.length);
  let changed = 0;
  let added = 0;
  let removed = 0;
  const samples: string[] = [];

  for (let index = 0; index < maxLines; index += 1) {
    const before = originalLines[index];
    const after = proposedLines[index];
    if (before === after) continue;
    changed += 1;
    if (before === undefined) {
      added += 1;
    } else if (after === undefined) {
      removed += 1;
    }
    if (samples.length < 3) {
      const beforePreview = before ? before.trim().slice(0, 60) : '(none)';
      const afterPreview = after ? after.trim().slice(0, 60) : '(none)';
      samples.push(`line ${index + 1}: "${beforePreview}" -> "${afterPreview}"`);
    }
  }

  return [
    `Changed ${changed} line(s); added ${added}; removed ${removed}.`,
    samples.length > 0 ? `Samples: ${samples.join(' | ')}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
  }

  throw new Error('Skill amendment proposal did not return valid JSON.');
}

function parseProposalOutput(text: string): {
  rationale: string;
  content: string;
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
  };
}

async function resolveCogneeRuntime(agentId: string, skillName: string) {
  const sessionId = `cognee:${skillName}`;
  const session = memoryService.getOrCreateSession(
    sessionId,
    null,
    'skill-cognee',
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
      channelType: 'skill-cognee',
      channelId: 'skill-cognee',
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

export async function proposeAmendment(input: {
  skillName: string;
  metrics: SkillHealthMetrics;
  agentId: string;
}): Promise<SkillAmendment> {
  const skill = resolveSkillCatalogEntry(input.skillName);
  const originalContent = fs.readFileSync(skill.filePath, 'utf-8');
  const failureObservations = getSkillObservations({
    skillName: skill.name,
    limit: 50,
  })
    .filter((observation) => observation.outcome !== 'success')
    .slice(0, 20)
    .map((observation) => ({
      outcome: observation.outcome,
      errorCategory: observation.error_category,
      errorDetail: observation.error_detail,
      userFeedback: observation.user_feedback,
      createdAt: observation.created_at,
    }));

  const proposalPrompt = [
    'You are reviewing a SKILL.md file that is underperforming.',
    'Propose a minimal, targeted amendment that addresses the observed failures without broadening scope.',
    'Preserve the existing voice, structure, and intent unless the failures require a small clarification.',
    'Return JSON only with this exact shape: {"rationale":"...","content":"<full amended SKILL.md content>"}.',
    '',
    `Skill name: ${skill.name}`,
    `Current file path: ${skill.filePath}`,
    '',
    'Health metrics:',
    JSON.stringify(input.metrics, null, 2),
    '',
    'Recent failures:',
    JSON.stringify(failureObservations, null, 2),
    '',
    'Current SKILL.md:',
    originalContent,
  ].join('\n');

  const runtime = await resolveCogneeRuntime(input.agentId, skill.name);
  const output = await runAgent({
    sessionId: runtime.sessionId,
    messages: [...runtime.messages, { role: 'user', content: proposalPrompt }],
    chatbotId: runtime.chatbotId,
    enableRag: runtime.enableRag,
    model: runtime.model,
    agentId: runtime.resolvedAgentId,
    channelId: 'skill-cognee',
    allowedTools: AMENDMENT_ALLOWED_TOOLS,
  });
  if (output.status === 'error' || !output.result?.trim()) {
    throw new Error(output.error || 'Skill amendment proposal failed.');
  }

  const proposal = parseProposalOutput(output.result);
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
    },
  });

  return amendment;
}

export function stageAmendment(amendment: SkillAmendment): number {
  return amendment.id;
}

export async function applyAmendment(input: {
  amendmentId: number;
  reviewedBy: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const amendment = getSkillAmendmentById(input.amendmentId);
  if (!amendment) {
    return { ok: false, reason: 'Amendment not found.' };
  }
  if (amendment.status !== 'staged') {
    return { ok: false, reason: 'Only staged amendments can be applied.' };
  }

  const currentContent = fs.readFileSync(amendment.skill_file_path, 'utf-8');
  if (sha256(currentContent) !== amendment.original_content_hash) {
    return {
      ok: false,
      reason: 'Skill file changed since the amendment was proposed.',
    };
  }

  fs.writeFileSync(amendment.skill_file_path, amendment.proposed_content, 'utf-8');
  updateAmendmentStatus({
    amendmentId: amendment.id,
    status: 'applied',
    reviewedBy: input.reviewedBy,
    resetRunsSinceApply: true,
  });
  recordAuditEvent({
    sessionId: `cognee:${amendment.skill_name}`,
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
  const amendment = getSkillAmendmentById(input.amendmentId);
  if (!amendment) {
    return { ok: false, reason: 'Amendment not found.' };
  }
  if (amendment.status !== 'staged') {
    return { ok: false, reason: 'Only staged amendments can be rejected.' };
  }

  updateAmendmentStatus({
    amendmentId: amendment.id,
    status: 'rejected',
    reviewedBy: input.reviewedBy,
  });
  recordAuditEvent({
    sessionId: `cognee:${amendment.skill_name}`,
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
