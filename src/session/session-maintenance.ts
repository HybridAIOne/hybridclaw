/**
 * Session maintenance keeps history until its memory flush is verified or skipped.
 * It handles compaction, not ordinary chat execution; a provider's successful
 * reply is not evidence that durable memory was stored.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DAILY_MEMORY_MAX_CHARS } from '#shared/daily-memory.js';
import {
  currentDateStampInTimezone,
  readUserTimezoneFile,
} from '#shared/workspace-time.js';
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
import {
  isScopeRunError,
  resolveScopeRun,
  scopeRunAgentParams,
} from '../scopes/scope-run.js';
import { loadSkills } from '../skills/skills.js';
import type { ChatMessage } from '../types/api.js';
import type { ContainerOutput } from '../types/container.js';
import type { CompactionResult } from '../types/memory.js';
import type { Session, StoredMessage } from '../types/session.js';
import { resolveHistoryBudgetTokens } from './context-budget.js';
import { memoryFlushExcerpts, verifiedMemoryFlush } from './memory-flush.js';
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

// Less room than this holds no durable fact worth a flush call.
const DAILY_NOTE_MIN_ROOM_CHARS = 500;

// The memory tool appends a blank line, the content and a newline to the trimmed note.
function dailyNoteIsFull(note: string): boolean {
  return (
    note.trimEnd().length + 3 + DAILY_NOTE_MIN_ROOM_CHARS >
    DAILY_MEMORY_MAX_CHARS
  );
}

function appendRejectedForSize(
  output: ContainerOutput,
  relativePath: string,
): boolean {
  if (output.status !== 'success') return false;
  return (output.toolExecutions ?? []).some(
    (tool) =>
      tool.name === 'memory' &&
      tool.isError &&
      tool.result.startsWith(`Error: ${relativePath} would exceed `),
  );
}

function buildSystemPrompt(
  agentId: string,
  sessionSummary?: string | null,
  extra?: string,
  promptMode: PromptMode = 'minimal',
  workspaceDir?: string,
): string {
  return buildSystemPromptFromHooks({
    agentId,
    workspaceDir,
    sessionSummary,
    skills: loadSkills(agentId, undefined, workspaceDir),
    purpose: 'memory-flush',
    promptMode,
    extraSafetyText: extra,
    runtimeInfo: {
      workspacePath: workspaceDir ?? agentWorkspaceDir(agentId),
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
}): Promise<boolean> {
  if (!PRE_COMPACTION_MEMORY_FLUSH_ENABLED) return true;

  const excerpts = memoryFlushExcerpts(
    params.olderMessages,
    PRE_COMPACTION_MEMORY_FLUSH_MAX_MESSAGES,
    PRE_COMPACTION_MEMORY_FLUSH_MAX_CHARS,
  );
  if (!excerpts.length) return true;

  // A scoped chat's notes go to its scope; a deleted scope keeps nothing.
  const scopeRun = await resolveScopeRun(
    memoryService.getSessionById(params.sessionId),
    params.agentId,
  );
  if (isScopeRunError(scopeRun)) return false;

  const workspaceDir =
    scopeRun?.workspaceDir ?? agentWorkspaceDir(params.agentId);
  const now = new Date();
  // The memory tool only writes today's note in the user's time zone.
  const dateStamp = currentDateStampInTimezone(
    readUserTimezoneFile(path.join(workspaceDir, 'USER.md')),
    now,
  );

  const flushPrompt = [
    'Pre-compaction memory flush.',
    `Store durable memories now using memory/${dateStamp}.md only (create memory/ if needed).`,
    "IMPORTANT: Append new content only to today's daily memory note. Do not write or rewrite MEMORY.md in this pass.",
    'Capture only stable, durable facts, preferences, and decisions worth preserving after compaction.',
    'Use memory action=append and report success only after it succeeds. If there is nothing worth saving, reply MEMORY_FLUSH_SKIPPED.',
    'Preserve complete durable preferences and recurring-task requirements, including selection criteria, exclusions, source lists, and output formats. Do not turn transient execution failures or time-sensitive task results into durable preferences.',
    'Read today’s note before appending to avoid saving the same facts again. Excerpts may continue across maintenance batches; preserve partial instructions for the next batch rather than discarding them.',
    '',
    `Current time: ${now.toISOString()}`,
    '',
    'Conversation excerpt (about to be compacted):',
  ].join('\n');

  const systemPrompt = buildSystemPrompt(
    params.agentId,
    params.sessionSummary,
    'Pre-compaction memory flush turn. The session is near auto-compaction; write durable memory to disk.',
    'minimal',
    scopeRun?.workspaceDir,
  );

  const messages: ChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

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
    const relativePath = `memory/${dateStamp}.md`;
    const filePath = path.join(workspaceDir, relativePath);
    const readNote = () => {
      try {
        return fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw err;
      }
    };
    const skipFullNote = (reason: string, noteChars: number) =>
      logger.warn(
        {
          sessionId: params.sessionId,
          notePath: relativePath,
          noteChars,
          reason,
        },
        "Pre-compaction memory flush skipped: today's note is full",
      );
    for (const [index, excerpt] of excerpts.entries()) {
      const before = readNote();
      if (dailyNoteIsFull(before)) {
        skipFullNote('no_room', before.length);
        break;
      }
      const output = await runAgent({
        sessionId: flushSessionId,
        messages: [
          ...messages,
          {
            role: 'user',
            content: `${flushPrompt}\nBatch ${index + 1}/${excerpts.length}\n${excerpt}`,
          },
        ],
        chatbotId,
        enableRag: params.enableRag,
        model,
        agentId: params.agentId,
        channelId: params.channelId,
        allowedTools: ['memory'],
        ...scopeRunAgentParams(scopeRun),
      });
      const after = readNote();
      if (verifiedMemoryFlush(output, relativePath, before, after)) continue;
      if (appendRejectedForSize(output, relativePath)) {
        skipFullNote('append_rejected', after.length);
        break;
      }
      logger.warn(
        { sessionId: params.sessionId, error: output.error },
        'Pre-compaction memory flush failed: no verified append or explicit skip',
      );
      return false;
    }
    memoryService.markSessionMemoryFlush(params.sessionId);
    const pluginManager =
      await tryEnsurePluginManagerInitializedForSessionMaintenance({
        sessionId: params.sessionId,
        agentId: params.agentId,
        channelId: params.channelId,
        context: 'memory flush',
      });
    if (pluginManager && !scopeRun) {
      await pluginManager.notifyMemoryFlush({
        sessionId: params.sessionId,
        agentId: params.agentId,
        channelId: params.channelId,
        olderMessages: params.olderMessages,
      });
    }
    return true;
  } catch (err) {
    logger.warn(
      { sessionId: params.sessionId, err },
      'Pre-compaction memory flush crashed',
    );
    return false;
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

  if (
    !(await runPreCompactionMemoryFlush({
      ...params,
      sessionSummary: session.session_summary,
      olderMessages: candidate.olderMessages,
    }))
  )
    return null;

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
