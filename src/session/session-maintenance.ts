import { runAgent } from '../agent/agent.js';
import type { PromptMode } from '../agent/prompt-hooks.js';
import { buildSystemPromptFromHooks } from '../agent/prompt-hooks.js';
import {
  PRE_COMPACTION_MEMORY_FLUSH_ENABLED,
  PRE_COMPACTION_MEMORY_FLUSH_MAX_CHARS,
  PRE_COMPACTION_MEMORY_FLUSH_MAX_MESSAGES,
  SESSION_COMPACTION_ENABLED,
  SESSION_COMPACTION_KEEP_RECENT,
  SESSION_COMPACTION_SUMMARY_MAX_CHARS,
  SESSION_COMPACTION_THRESHOLD,
} from '../config/config.js';
import { stopSessionHostProcess } from '../infra/host-runner.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { logger } from '../logger.js';
import { memoryService } from '../memory/memory-service.js';
import {
  ensurePluginManagerInitialized,
  type PluginManager,
} from '../plugins/plugin-manager.js';
import { callAuxiliaryModel } from '../providers/auxiliary.js';
import { resolveTaskModelPolicy } from '../providers/task-routing.js';
import { loadSkills } from '../skills/skills.js';
import type { ChatMessage } from '../types/api.js';
import type { StoredMessage } from '../types/session.js';
import { resolveHistoryBudgetTokens } from './context-budget.js';
import { exportCompactedSessionJsonl } from './session-export.js';
import {
  estimateTokenCountFromMessages,
  estimateTokenCountFromText,
} from './token-efficiency.js';
import { expandStoredMessage } from './tool-history.js';

const COMPACTION_SOURCE_MAX_MESSAGES = 240;
const COMPACTION_SOURCE_MAX_CHARS = 80_000;
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

function normalizeSummary(summary: string): string {
  let text = summary.trim();
  if (text.startsWith('```')) {
    text = text
      .replace(/^```[a-z0-9_-]*\s*/i, '')
      .replace(/```$/i, '')
      .trim();
  }
  if (text.length > SESSION_COMPACTION_SUMMARY_MAX_CHARS) {
    text = `${text.slice(0, SESSION_COMPACTION_SUMMARY_MAX_CHARS)}\n\n...[truncated]`;
  }
  return text;
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

async function generateCompactionSummary(params: {
  sessionId: string;
  agentId: string;
  chatbotId: string;
  enableRag: boolean;
  model: string;
  channelId: string;
  previousSummary: string | null;
  olderMessages: StoredMessage[];
}): Promise<string | null> {
  const transcript = formatMessagesForPrompt(
    params.olderMessages,
    COMPACTION_SOURCE_MAX_MESSAGES,
    COMPACTION_SOURCE_MAX_CHARS,
  );
  if (!transcript) return null;

  const previous = params.previousSummary?.trim() || '(none)';
  const systemPrompt = [
    'You are compressing conversation history for a long-running AI session.',
    'Return an updated markdown summary that preserves durable context only.',
    'Focus on goals, decisions, constraints, preferences, and open follow-ups.',
    'Do not include low-value chatter, greetings, or transient details.',
    'Return summary text only.',
  ].join(' ');

  const userPrompt = [
    'Existing summary:',
    previous,
    '',
    'Messages to compact:',
    transcript,
    '',
    'Return a single merged summary that should replace the existing summary.',
  ].join('\n');

  try {
    const result = await callAuxiliaryModel({
      task: 'compression',
      agentId: params.agentId,
      fallbackModel: params.model,
      fallbackChatbotId: params.chatbotId,
      fallbackEnableRag: params.enableRag,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    const normalized = normalizeSummary(result.content);
    return normalized || null;
  } catch (err) {
    logger.warn(
      {
        sessionId: params.sessionId,
        err,
      },
      'Session compaction summary failed',
    );
    return null;
  }
}

export async function maybeCompactSession(params: {
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
}): Promise<void> {
  if (!SESSION_COMPACTION_ENABLED) return;

  const session = memoryService.getSessionById(params.sessionId);
  if (!session) return;

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
  const shouldCompactForTokens = msgTokens > historyBudget;
  const shouldCompactForMessageCount = session.message_count >= threshold;

  logger.debug(
    {
      sessionId: params.sessionId,
      messageCount: session.message_count,
      loadedMessages: allMessages.length,
      msgTokens,
      promptOverheadTokens,
      historyBudget,
      keepRecent,
      triggerThreshold: threshold,
      shouldCompactForTokens,
      shouldCompactForMessageCount,
    },
    'Session compaction budget check',
  );

  if (!shouldCompactForTokens && !shouldCompactForMessageCount) return;

  const candidate = memoryService.getCompactionCandidateMessages(
    params.sessionId,
    keepRecent,
  );
  if (!candidate || candidate.olderMessages.length === 0) return;

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
      return;
    }
  }

  await runPreCompactionMemoryFlush({
    ...params,
    sessionSummary: session.session_summary,
    olderMessages: candidate.olderMessages,
  });

  const summary = await generateCompactionSummary({
    ...params,
    previousSummary: session.session_summary,
    olderMessages: candidate.olderMessages,
  });
  if (!summary) return;

  const deleted = memoryService.deleteMessagesBeforeId(
    params.sessionId,
    candidate.cutoffId,
  );
  if (deleted <= 0) return;

  memoryService.updateSessionSummary(params.sessionId, summary);
  const retainedMessages = memoryService.getRecentMessages(
    params.sessionId,
    keepRecent,
  );
  const exported = exportCompactedSessionJsonl({
    agentId: params.agentId,
    sessionId: params.sessionId,
    channelId: params.channelId,
    summary,
    compactedMessages: candidate.olderMessages,
    retainedMessages,
    deletedCount: deleted,
    cutoffId: candidate.cutoffId,
  });
  logger.info(
    {
      sessionId: params.sessionId,
      deleted,
      cutoffId: candidate.cutoffId,
      threshold,
      keepRecent,
      msgTokens,
      promptOverheadTokens,
      historyBudget,
      shouldCompactForTokens,
      shouldCompactForMessageCount,
      exportPath: exported?.path || null,
    },
    'Session compacted',
  );
  if (pluginManager) {
    await pluginManager.notifyAfterCompaction({
      sessionId: params.sessionId,
      agentId: params.agentId,
      channelId: params.channelId,
      summary,
      olderMessages: candidate.olderMessages,
    });
  }
}
