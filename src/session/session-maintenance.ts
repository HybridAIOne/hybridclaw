import { runAgent } from '../agent/agent.js';
import type { PromptMode } from '../agent/prompt-hooks.js';
import { buildSystemPromptFromHooks } from '../agent/prompt-hooks.js';
import {
  PRE_COMPACTION_MEMORY_FLUSH_ENABLED,
  PRE_COMPACTION_MEMORY_FLUSH_MAX_CHARS,
  PRE_COMPACTION_MEMORY_FLUSH_MAX_MESSAGES,
  SESSION_COMPACTION_ENABLED,
  SESSION_COMPACTION_KEEP_RECENT,
  SESSION_COMPACTION_THRESHOLD,
} from '../config/config.js';
import { stopSessionHostProcess } from '../infra/host-runner.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { logger } from '../logger.js';
import { NoCompactableMessagesError } from '../memory/compaction.js';
import { memoryService } from '../memory/memory-service.js';
import {
  ensurePluginManagerInitialized,
  type PluginManager,
} from '../plugins/plugin-manager.js';
import { resolveTaskModelPolicy } from '../providers/task-routing.js';
import { loadSkills } from '../skills/skills.js';
import type { ChatMessage } from '../types/api.js';
import type { CompactionResult } from '../types/memory.js';
import type { Session, StoredMessage } from '../types/session.js';
import { resolveHistoryBudgetTokens } from './context-budget.js';
import {
  estimateTokenCountFromMessages,
  estimateTokenCountFromText,
} from './token-efficiency.js';
import { expandStoredMessage } from './tool-history.js';

// Half the history budget stays verbatim after compaction (owner call,
// 2026-09-21): compaction then runs about once per half budget of new turns
// instead of on every turn.
const RETAINED_HISTORY_SHARE = 0.5;

function estimateStoredMessageTokens(message: StoredMessage): number {
  return estimateTokenCountFromMessages(expandStoredMessage(message));
}

/**
 * Newest messages to keep verbatim: bounded by `keepRecent`, by the retained
 * token share, and aligned so the kept slice starts at a user turn. The newest
 * turn is always kept whole.
 */
export function resolveRetainedMessageCount(
  messages: StoredMessage[],
  maxMessages: number,
  maxTokens: number,
): number {
  if (messages.length === 0) return 0;
  let retained = 0;
  let tokens = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const count = messages.length - index;
    tokens += estimateStoredMessageTokens(messages[index]);
    if (retained > 0 && (count > maxMessages || tokens > maxTokens)) break;
    if (messages[index].role === 'user') retained = count;
  }
  return Math.max(1, retained);
}

function formatDateStampInLocalTimezone(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (year && month && day) {
    return `${year}-${month}-${day}`;
  }
  return now.toISOString().slice(0, 10);
}

function formatMessagesForPrompt(
  messages: StoredMessage[],
  maxMessages: number,
  maxChars: number,
): string {
  const selected = messages.slice(-Math.max(1, maxMessages));
  const lines: string[] = [];
  let usedChars = 0;

  for (const msg of selected) {
    const role = (msg.role || 'unknown').toUpperCase();
    const compact = msg.content.replace(/\r/g, '').trim();
    const bounded =
      compact.length > 1_200
        ? `${compact.slice(0, 1_200)}\n...[truncated]`
        : compact;
    const entry = `[${role}] ${bounded}`;
    const bytes = entry.length + 2;
    if (usedChars + bytes > maxChars) break;
    usedChars += bytes;
    lines.push(entry);
  }

  return lines.join('\n\n');
}

function buildSystemPrompt(
  agentId: string,
  sessionSummary?: string | null,
  extra?: string,
  promptMode: PromptMode = 'minimal',
): string {
  return buildSystemPromptFromHooks({
    agentId,
    sessionSummary,
    skills: loadSkills(agentId, undefined),
    purpose: 'memory-flush',
    promptMode,
    extraSafetyText: extra,
    runtimeInfo: {
      workspacePath: agentWorkspaceDir(agentId),
    },
    allowedTools: ['memory'],
  });
}

async function tryEnsurePluginManagerInitializedForSessionMaintenance(params: {
  sessionId: string;
  agentId: string;
  channelId: string;
  context: string;
}): Promise<PluginManager | null> {
  try {
    return await ensurePluginManagerInitialized();
  } catch (err) {
    logger.warn(
      {
        sessionId: params.sessionId,
        agentId: params.agentId,
        channelId: params.channelId,
        err,
      },
      `Plugin manager init failed; proceeding without ${params.context} plugin hooks`,
    );
    return null;
  }
}

export async function runPreCompactionMemoryFlush(params: {
  sessionId: string;
  agentId: string;
  chatbotId: string;
  enableRag: boolean;
  model: string;
  channelId: string;
  sessionSummary: string | null;
  olderMessages: StoredMessage[];
}): Promise<void> {
  if (!PRE_COMPACTION_MEMORY_FLUSH_ENABLED) return;

  const transcript = formatMessagesForPrompt(
    params.olderMessages,
    PRE_COMPACTION_MEMORY_FLUSH_MAX_MESSAGES,
    PRE_COMPACTION_MEMORY_FLUSH_MAX_CHARS,
  );
  if (!transcript) return;

  const now = new Date();
  const dateStamp = formatDateStampInLocalTimezone(now);

  const flushPrompt = [
    'Pre-compaction memory flush.',
    `Store durable memories now using memory/${dateStamp}.md only (create memory/ if needed).`,
    "IMPORTANT: Append new content only to today's daily memory note. Do not write or rewrite MEMORY.md in this pass.",
    'Capture only stable, durable facts, preferences, and decisions worth preserving after compaction.',
    'If there is nothing worth saving, reply MEMORY_FLUSH_SKIPPED.',
    '',
    `Current time: ${now.toISOString()}`,
    '',
    'Conversation excerpt (about to be compacted):',
    transcript,
  ].join('\n');

  const systemPrompt = buildSystemPrompt(
    params.agentId,
    params.sessionSummary,
    'Pre-compaction memory flush turn. The session is near auto-compaction; write durable memory to disk.',
  );

  const messages: ChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: flushPrompt });

  let model = params.model;
  let chatbotId = params.chatbotId;
  try {
    const taskModel = await resolveTaskModelPolicy('flush_memories', {
      agentId: params.agentId,
      chatbotId: params.chatbotId,
    });
    if (taskModel?.error) {
      logger.warn(
        { sessionId: params.sessionId, error: taskModel.error },
        'Pre-compaction memory flush auxiliary model is misconfigured; falling back to the active model',
      );
    } else if (taskModel?.model) {
      model = taskModel.model;
      chatbotId = String(taskModel.chatbotId || '').trim() || params.chatbotId;
    }
  } catch (err) {
    logger.warn(
      { sessionId: params.sessionId, err },
      'Failed to resolve pre-compaction memory flush task model; falling back to the active model',
    );
  }

  const flushSessionId = `memory-flush:${params.sessionId}:${Date.now()}`;
  try {
    const output = await runAgent({
      sessionId: flushSessionId,
      messages,
      chatbotId,
      enableRag: params.enableRag,
      model,
      agentId: params.agentId,
      channelId: params.channelId,
      allowedTools: ['memory'],
    });
    if (output.status === 'error') {
      logger.warn(
        { sessionId: params.sessionId, error: output.error },
        'Pre-compaction memory flush failed',
      );
      return;
    }
    memoryService.markSessionMemoryFlush(params.sessionId);
    const pluginManager =
      await tryEnsurePluginManagerInitializedForSessionMaintenance({
        sessionId: params.sessionId,
        agentId: params.agentId,
        channelId: params.channelId,
        context: 'memory flush',
      });
    if (pluginManager) {
      await pluginManager.notifyMemoryFlush({
        sessionId: params.sessionId,
        agentId: params.agentId,
        channelId: params.channelId,
        olderMessages: params.olderMessages,
      });
    }
  } catch (err) {
    logger.warn(
      { sessionId: params.sessionId, err },
      'Pre-compaction memory flush crashed',
    );
  } finally {
    stopSessionHostProcess(flushSessionId);
  }
}

export interface SessionCompactionTarget {
  sessionId: string;
  agentId: string;
  chatbotId: string;
  enableRag: boolean;
  model: string;
  channelId: string;
  promptMode?: PromptMode;
  /**
   * Estimated tokens of the system blocks plus dynamic context from the turn
   * that just completed. When omitted, a minimal system prompt is estimated.
   */
  promptOverheadTokens?: number;
}

interface CompactionPlan {
  session: Session;
  allMessages: StoredMessage[];
  msgTokens: number;
  promptOverheadTokens: number;
  historyBudget: number;
  keepRecent: number;
  threshold: number;
}

function planCompaction(
  params: SessionCompactionTarget,
): CompactionPlan | null {
  const session = memoryService.getSessionById(params.sessionId);
  if (!session) return null;

  const threshold = Math.max(SESSION_COMPACTION_THRESHOLD, 20);
  const allMessages = memoryService.getRecentMessages(params.sessionId);
  const msgTokens = allMessages.reduce(
    (total, message) => total + estimateStoredMessageTokens(message),
    0,
  );
  const promptOverheadTokens =
    params.promptOverheadTokens ??
    estimateTokenCountFromText(session.session_summary) +
      estimateTokenCountFromText(
        buildSystemPrompt(
          params.agentId,
          session.session_summary,
          undefined,
          params.promptMode ?? 'minimal',
        ),
      );
  const historyBudget = resolveHistoryBudgetTokens({
    model: params.model,
    promptOverheadTokens,
  });
  const keepRecent = Math.min(
    resolveRetainedMessageCount(
      allMessages,
      SESSION_COMPACTION_KEEP_RECENT,
      Math.floor(historyBudget * RETAINED_HISTORY_SHARE),
    ),
    Math.max(1, threshold - 1),
    Math.max(1, allMessages.length - 1),
  );
  return {
    session,
    allMessages,
    msgTokens,
    promptOverheadTokens,
    historyBudget,
    keepRecent,
    threshold,
  };
}

/**
 * Runs the shared compaction engine for a session: plugin hooks, the
 * pre-compaction memory flush, then summary, archive, and row deletion via
 * `memoryService.compactSession`. Returns null when nothing was compacted.
 */
export async function compactSessionNow(
  params: SessionCompactionTarget,
): Promise<CompactionResult | null> {
  const plan = planCompaction(params);
  if (!plan) return null;
  return runCompaction(params, plan);
}

async function runCompaction(
  params: SessionCompactionTarget,
  plan: CompactionPlan,
): Promise<CompactionResult | null> {
  const { session, keepRecent } = plan;
  const candidate = memoryService.getCompactionCandidateMessages(
    params.sessionId,
    keepRecent,
  );
  if (!candidate || candidate.olderMessages.length === 0) return null;

  const pluginManager =
    await tryEnsurePluginManagerInitializedForSessionMaintenance({
      sessionId: params.sessionId,
      agentId: params.agentId,
      channelId: params.channelId,
      context: 'compaction',
    });
  if (pluginManager) {
    await pluginManager.notifyBeforeCompaction({
      sessionId: params.sessionId,
      agentId: params.agentId,
      channelId: params.channelId,
      summary: session.session_summary,
      olderMessages: candidate.olderMessages,
    });
  }
  if (pluginManager) {
    const memoryBehavior = await pluginManager.getMemoryLayerBehavior();
    if (memoryBehavior.replacesBuiltInMemory) {
      logger.debug(
        {
          sessionId: params.sessionId,
          agentId: params.agentId,
          channelId: params.channelId,
        },
        'Session compaction skipped because a plugin memory layer replaces built-in memory',
      );
      return null;
    }
  }

  await runPreCompactionMemoryFlush({
    ...params,
    sessionSummary: session.session_summary,
    olderMessages: candidate.olderMessages,
  });

  let result: CompactionResult;
  try {
    result = await memoryService.compactSession(params.sessionId, {
      retainRecentCount: keepRecent,
    });
  } catch (err) {
    if (err instanceof NoCompactableMessagesError) return null;
    throw err;
  }

  logger.info(
    {
      sessionId: params.sessionId,
      compacted: result.messagesCompacted,
      preserved: result.messagesPreserved,
      cutoffId: candidate.cutoffId,
      threshold: plan.threshold,
      keepRecent,
      msgTokens: plan.msgTokens,
      promptOverheadTokens: plan.promptOverheadTokens,
      historyBudget: plan.historyBudget,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      stages: result.stages.length,
      archivePath: result.archivePath,
    },
    'Session compacted',
  );
  if (pluginManager) {
    await pluginManager.notifyAfterCompaction({
      sessionId: params.sessionId,
      agentId: params.agentId,
      channelId: params.channelId,
      summary:
        memoryService.getSessionById(params.sessionId)?.session_summary ?? null,
      olderMessages: candidate.olderMessages,
    });
  }
  return result;
}

export async function maybeCompactSession(
  params: SessionCompactionTarget,
): Promise<void> {
  if (!SESSION_COMPACTION_ENABLED) return;

  const plan = planCompaction(params);
  if (!plan) return;

  const shouldCompactForTokens = plan.msgTokens > plan.historyBudget;
  const shouldCompactForMessageCount =
    plan.session.message_count >= plan.threshold;

  logger.debug(
    {
      sessionId: params.sessionId,
      messageCount: plan.session.message_count,
      loadedMessages: plan.allMessages.length,
      msgTokens: plan.msgTokens,
      promptOverheadTokens: plan.promptOverheadTokens,
      historyBudget: plan.historyBudget,
      keepRecent: plan.keepRecent,
      triggerThreshold: plan.threshold,
      shouldCompactForTokens,
      shouldCompactForMessageCount,
    },
    'Session compaction budget check',
  );

  if (!shouldCompactForTokens && !shouldCompactForMessageCount) return;
  await runCompaction(params, plan);
}
