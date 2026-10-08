/**
 * Boost questions: a HybridAI tool result that offers to spend one of the
 * user's boosts ends the turn with an approval the app shows as its boost
 * popup, and the user's answer repeats the exact call with that answer.
 *
 * Only a user message answers (`/boost use|skip <id>`, or yes/no), and the
 * model never sees the offer id or the boost `_meta`. A session has at most
 * one open question, kept in its state dir until it is answered, a normal
 * approval supersedes it, or it expires; an expired offer lapses unanswered,
 * so nothing is spent and nothing runs again. NOT the approval policy
 * (`approval-policy.ts`): a boost is asked in every approval mode and never
 * becomes session, agent or workspace trust.
 */
import fs from 'node:fs';
import type { BoostOffer } from '../shared/boost-offer.js';
import { parseBoostOffer } from '../shared/boost-offer.js';
import {
  type ApprovalPrelude,
  latestUserMessageText,
  parseApprovalUserResponse,
} from './approval-policy.js';
import { approvalReviewArguments } from './approval-review.js';
import { approvalOutputPresentation } from './chat-segments.js';
import { emitRuntimeEvent } from './extensions.js';
import { ensureSessionStateDir, sessionStatePath } from './session-state.js';
import { approvalRuntime, emitApprovalProgress } from './tool-approval.js';
import type {
  ArtifactMetadata,
  ChatMessage,
  ContainerOutput,
  PendingApproval,
  TokenUsageStats,
  ToolExecution,
} from './types.js';

const PENDING_BOOST_FILE = 'pending-boost.json';
const BOOST_ANSWER_RE = /^\/boost\s+(use|skip)\s+(\S+)$/i;

interface PendingBoost {
  offer: BoostOffer;
  toolName: string;
  argsJson: string;
  originalPrompt: string;
  expiresAtMs: number;
}

function readPendingBoost(sessionId: string): PendingBoost | null {
  let raw: unknown;
  try {
    raw = JSON.parse(
      fs.readFileSync(sessionStatePath(sessionId, PENDING_BOOST_FILE), 'utf-8'),
    );
  } catch {
    return null;
  }
  const record = (raw || {}) as Record<string, unknown>;
  const offer = parseBoostOffer(record.offer);
  if (
    !offer ||
    typeof record.toolName !== 'string' ||
    typeof record.argsJson !== 'string' ||
    typeof record.originalPrompt !== 'string' ||
    typeof record.expiresAtMs !== 'number'
  ) {
    return null;
  }
  return {
    offer,
    toolName: record.toolName,
    argsJson: record.argsJson,
    originalPrompt: record.originalPrompt,
    expiresAtMs: record.expiresAtMs,
  };
}

function writePendingBoost(sessionId: string, pending: PendingBoost): void {
  const filePath = sessionStatePath(sessionId, PENDING_BOOST_FILE);
  try {
    ensureSessionStateDir(filePath);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({ version: 1, ...pending }), {
      mode: 0o600,
    });
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    // The answer then finds no open question, so no boost is spent.
    console.error('[boost] failed to persist the open question:', error);
  }
}

/** Drops the session's open boost question, e.g. when a newer approval asks. */
export function dropPendingBoost(sessionId: string): void {
  fs.rmSync(sessionStatePath(sessionId, PENDING_BOOST_FILE), { force: true });
}

/**
 * Ends the turn on a boost offer: records the question and returns the
 * waiting-for-approval output whose `pendingApproval.boost` the apps render.
 */
export async function boostApprovalOutput(params: {
  sessionId: string;
  offer: BoostOffer;
  toolName: string;
  argsJson: string;
  execution: ToolExecution;
  originalPrompt: string;
  toolsUsed: string[];
  toolExecutions: ToolExecution[];
  artifacts: ArtifactMetadata[];
  tokenUsage: TokenUsageStats;
}): Promise<ContainerOutput> {
  const { offer, toolName, argsJson } = params;
  const timeoutSecs =
    approvalRuntime.reloadPolicyIfNeeded().approvalTimeoutSecs;
  const expiresAtMs = Date.now() + timeoutSecs * 1_000;
  writePendingBoost(params.sessionId, {
    offer,
    toolName,
    argsJson,
    originalPrompt: params.originalPrompt,
    expiresAtMs,
  });

  // The prompt is stored as Hy's reply, which the model reads later: no id.
  const intent = `use 1 boost for ${offer.modelName}`;
  const reason = `This uses 1 of your ${offer.available} boosts.`;
  const prompt = [
    `Use 1 boost (${offer.available} left) for ${offer.modelName}?`,
    'Reply `yes` to use it, or `no` to continue without it.',
    `Approval expires in ${timeoutSecs}s.`,
  ].join('\n');
  const pendingApproval: PendingApproval = {
    approvalId: offer.id,
    prompt,
    intent,
    reason,
    toolName,
    reviewArguments: approvalReviewArguments(toolName, argsJson),
    allowSession: false,
    allowAgent: false,
    allowAll: false,
    expiresAt: expiresAtMs,
    boost: {
      category: offer.category,
      modelName: offer.modelName,
      available: offer.available,
    },
  };
  emitApprovalProgress(pendingApproval);
  params.toolExecutions.push({
    ...params.execution,
    result: prompt,
    isError: false,
    blocked: true,
    blockedReason: reason,
    escalationRoute: 'approval_request',
    approvalDecision: 'required',
    approvalIntent: intent,
    approvalReason: reason,
    approvalRequestId: offer.id,
    approvalExpiresAt: expiresAtMs,
    approvalAllowSession: false,
    approvalAllowAgent: false,
    approvalAllowAll: false,
  });
  const output: ContainerOutput = {
    status: 'success',
    result: prompt,
    toolsUsed: [...new Set(params.toolsUsed)],
    outputPresentation: approvalOutputPresentation(),
    ...(params.artifacts.length > 0 ? { artifacts: params.artifacts } : {}),
    toolExecutions: params.toolExecutions,
    pendingApproval,
    tokenUsage: params.tokenUsage,
    effectiveUserPrompt: params.originalPrompt,
  };
  await emitRuntimeEvent({
    event: 'turn_end',
    status: output.status,
    toolsUsed: output.toolsUsed,
  });
  return output;
}

function parseBoostAnswer(
  text: string,
): { use: boolean; offerId: string } | null {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  for (const candidate of [text, lines.at(-1) || '']) {
    const match = candidate.trim().match(BOOST_ANSWER_RE);
    if (match) {
      return { use: match[1].toLowerCase() === 'use', offerId: match[2] };
    }
  }
  return null;
}

/**
 * Answers the session's open boost question from the latest user message.
 * `/boost use|skip <id>` is always handled here, so an id never reaches the
 * model; yes/no (with the offer id or none) answers a live question. Returns
 * null for anything else, which leaves the question open.
 */
export function handleBoostAnswer(
  sessionId: string,
  messages: ChatMessage[],
): ApprovalPrelude | null {
  const text = latestUserMessageText(messages);
  if (!text) return null;
  const pending = readPendingBoost(sessionId);
  const live = pending && pending.expiresAtMs > Date.now() ? pending : null;
  if (pending && !live) dropPendingBoost(sessionId);

  let use: boolean;
  const typed = parseBoostAnswer(text);
  if (typed) {
    if (!live || typed.offerId !== live.offer.id) {
      return {
        immediateMessage:
          'That boost offer is no longer open, so no boost was spent.',
      };
    }
    use = typed.use;
  } else {
    const reply = live ? parseApprovalUserResponse(text) : null;
    if (!live || !reply) return null;
    if (reply.requestId && reply.requestId !== live.offer.id) return null;
    use = reply.kind === 'approve';
  }

  dropPendingBoost(sessionId);
  return {
    replayPrompt: [
      '[Boost question answered]',
      `The user chose ${use ? 'to use' : 'not to use'} a boost for this tool call, which runs again now with their answer. Continue from its result.`,
      '',
      `Original user request: ${live.originalPrompt}`,
    ].join('\n'),
    approvedToolCall: {
      toolName: live.toolName,
      argsJson: live.argsJson,
      boost: { offer: live.offer.id, use },
    },
  };
}
