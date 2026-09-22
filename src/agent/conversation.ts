/**
 * Conversation prompts replay persisted tool exchanges alongside their final
 * assistant message. Audit events are never promoted into prompt instructions.
 */
import os from 'node:os';
import { DYNAMIC_CONTEXT_MESSAGE_PREFIX } from '../../container/shared/dynamic-context.js';
import { currentDateStampInTimezone } from '../../container/shared/workspace-time.js';
import { normalizeSkillConfigChannelKind } from '../channels/channel-registry.js';
import { scheduleCloudMemorySync } from '../memory/cloud-memory.js';
import { resolveHistoryBudgetTokens } from '../session/context-budget.js';
import {
  buildSessionContextPrompt,
  type SessionContext,
} from '../session/session-context.js';
import {
  estimateTokenCountFromMessages,
  type HistoryOptimizationStats,
  optimizeHistoryMessagesForPrompt,
} from '../session/token-efficiency.js';
import { expandStoredMessage } from '../session/tool-history.js';
import {
  loadSkills,
  resolveSkillInvocationForTurn,
  type Skill,
  type SkillInvocation,
} from '../skills/skills.js';
import type { ChatMessage } from '../types/api.js';
import {
  formatCurrentTime,
  loadRecentDailyMemoryFiles,
  loadStaticBootstrapFiles,
  resolveUserTimezoneFromContextFiles,
} from '../workspace.js';
import {
  buildRetrievedContextPrompt,
  buildSessionSummaryPrompt,
  buildSystemPromptBlocksFromHooks,
  type PromptHookContext,
  type PromptMode,
  type PromptPartName,
  type PromptRuntimeInfo,
  type SkillPromptMode,
  shouldRenderSessionContext,
} from './prompt-hooks.js';
import { mergeAllowedToolNames, mergeBlockedToolNames } from './tool-policy.js';

interface HistoryMessage {
  role: string;
  content: ChatMessage['content'];
  session_id?: string;
  tool_history_json?: string | null;
}

const HOSTNAME = sanitizeDynamicContextValue(os.hostname());

function sanitizeDynamicContextValue(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export interface HistoryWindowNote {
  droppedTurns: number;
  droppedMessages: number;
  /** True when stored rows older than the loaded history were not fetched. */
  historyTruncated: boolean;
}

export function buildHistoryWindowPrompt(
  note: HistoryWindowNote | null | undefined,
): string {
  if (!note) return '';
  const lines: string[] = [];
  if (note.droppedTurns > 0) {
    lines.push(
      `The oldest ${note.droppedTurns} turn(s) (${note.droppedMessages} messages) of this session were omitted from the messages above to fit the history budget.`,
    );
  }
  if (note.historyTruncated) {
    lines.push(
      'Older messages beyond the loaded history window are also omitted.',
    );
  }
  if (lines.length === 0) return '';
  lines.push(
    'The omitted turns are not summarized; do not assume you have seen them.',
  );
  return ['## History Window', ...lines].join('\n');
}

interface DynamicContextMessageOptions {
  agentId?: string;
  now?: Date;
  retrievedContext?: string | null;
  sessionSummary?: string | null;
  historyWindow?: HistoryWindowNote | null;
  /**
   * Per-session identity block (platform, session id, session key, user).
   * Rendered here rather than in the system prompt so a new session does not
   * invalidate the provider's prompt cache for the static prefix.
   */
  sessionContext?: SessionContext | null;
}

export function buildDynamicContextMessage(
  options: Date | DynamicContextMessageOptions = {},
): ChatMessage {
  const now = options instanceof Date ? options : options.now || new Date();
  const agentId = options instanceof Date ? undefined : options.agentId;
  const lines = [
    `${DYNAMIC_CONTEXT_MESSAGE_PREFIX}${now.toISOString().slice(0, 10)}`,
  ];
  const dynamicSections: string[] = [];
  if (!(options instanceof Date)) {
    if (options.sessionContext) {
      dynamicSections.push(buildSessionContextPrompt(options.sessionContext));
    }
    dynamicSections.push(
      buildHistoryWindowPrompt(options.historyWindow),
      buildSessionSummaryPrompt(options.sessionSummary),
      buildRetrievedContextPrompt(options.retrievedContext),
    );
  }

  if (agentId) {
    const contextFiles = loadStaticBootstrapFiles(agentId);
    const userTimezone = resolveUserTimezoneFromContextFiles(contextFiles);
    lines.push(
      `Daily note: memory/${currentDateStampInTimezone(userTimezone, now)}.md`,
    );
    lines.push(`Current Date & Time: ${formatCurrentTime(userTimezone, now)}`);

    const dailyMemoryFiles = loadRecentDailyMemoryFiles(agentId, {
      now,
      contextFiles,
    });
    if (HOSTNAME) {
      lines.push(`Host: ${HOSTNAME}`);
    }
    lines.push('</context>');

    for (const dailyMemoryFile of dailyMemoryFiles) {
      dynamicSections.push(
        [
          `## Daily Memory (${dailyMemoryFile.name})`,
          '',
          dailyMemoryFile.content,
        ].join('\n'),
      );
    }
  } else {
    if (HOSTNAME) {
      lines.push(`Host: ${HOSTNAME}`);
    }
    lines.push('</context>');
  }

  return {
    role: 'user',
    content: [lines.join('\n'), ...dynamicSections.filter(Boolean)].join(
      '\n\n',
    ),
  };
}

function resolvePreviousUserContent(history: HistoryMessage[]): string | null {
  // Conversation history enters this function newest-first from storage.
  const previousUserMessage = history.find(
    (message) => message.role === 'user',
  );
  return typeof previousUserMessage?.content === 'string'
    ? previousUserMessage.content
    : null;
}

export interface ConversationContext {
  messages: ChatMessage[];
  skills: Skill[];
  historyStats: HistoryOptimizationStats;
  /** Estimated tokens of the system blocks plus the dynamic context message. */
  promptOverheadTokens: number;
  explicitSkillInvocation: SkillInvocation | null;
}

export function buildConversationContext(params: {
  agentId: string;
  sessionSummary?: string | null;
  retrievedContext?: string | null;
  history: HistoryMessage[];
  /** True when the caller's history fetch hit its row limit. */
  historyTruncated?: boolean;
  promptMode?: PromptMode;
  skillPromptMode?: SkillPromptMode;
  includePromptParts?: PromptPartName[];
  omitPromptParts?: PromptPartName[];
  extraSafetyText?: string;
  runtimeInfo?: PromptRuntimeInfo;
  allowedTools?: string[];
  blockedTools?: string[];
  currentUserContent?: ChatMessage['content'];
}): ConversationContext {
  const {
    agentId,
    sessionSummary,
    retrievedContext,
    history,
    historyTruncated = false,
    promptMode = 'full',
    skillPromptMode = 'full',
    includePromptParts,
    omitPromptParts,
    extraSafetyText,
    runtimeInfo,
    allowedTools,
    blockedTools,
    currentUserContent,
  } = params;
  if (promptMode !== 'none') {
    scheduleCloudMemorySync(agentId);
  }
  const mergedBlockedTools = mergeBlockedToolNames({ explicit: blockedTools });
  const mergedAllowedTools = mergeAllowedToolNames({
    agentId,
    explicit: allowedTools,
  });
  const skills = loadSkills(
    agentId,
    normalizeSkillConfigChannelKind(runtimeInfo?.channel?.kind),
  );
  const previousUserContent = resolvePreviousUserContent(history);
  const explicitSkillInvocation =
    typeof currentUserContent === 'string' && currentUserContent.trim()
      ? resolveSkillInvocationForTurn({
          content: currentUserContent,
          skills,
          previousUserContent,
        })
      : null;
  const hookContext: PromptHookContext = {
    agentId,
    skills,
    explicitSkillInvocation,
    purpose: 'conversation',
    promptMode,
    skillPromptMode,
    includePromptParts,
    omitPromptParts,
    extraSafetyText,
    runtimeInfo,
    allowedTools: mergedAllowedTools,
    blockedTools: mergedBlockedTools,
  };
  const systemPromptBlocks = buildSystemPromptBlocksFromHooks(hookContext);

  const messages: ChatMessage[] = [];
  if (systemPromptBlocks.length > 0) {
    messages.push(
      ...systemPromptBlocks.map(
        (content): ChatMessage => ({ role: 'system', content }),
      ),
    );
  }

  const buildDynamicContext = (
    historyWindow: HistoryWindowNote | null,
  ): ChatMessage =>
    buildDynamicContextMessage({
      agentId,
      retrievedContext,
      sessionSummary,
      historyWindow,
      sessionContext: shouldRenderSessionContext(hookContext)
        ? runtimeInfo?.sessionContext
        : null,
    });
  const promptOverheadTokens =
    systemPromptBlocks.length > 0
      ? estimateTokenCountFromMessages([...messages, buildDynamicContext(null)])
      : 0;

  const historyMessages = [...history].reverse().flatMap(expandStoredMessage);
  const optimizedHistory = optimizeHistoryMessagesForPrompt(historyMessages, {
    maxTokens: resolveHistoryBudgetTokens({
      model: runtimeInfo?.model,
      promptOverheadTokens,
    }),
  });

  messages.push(...optimizedHistory.messages);
  if (systemPromptBlocks.length > 0) {
    const { droppedTurns, droppedCount } = optimizedHistory.stats;
    messages.push(
      buildDynamicContext(
        droppedTurns > 0 || historyTruncated
          ? {
              droppedTurns,
              droppedMessages: droppedCount,
              historyTruncated,
            }
          : null,
      ),
    );
  }
  return {
    messages,
    skills,
    historyStats: optimizedHistory.stats,
    promptOverheadTokens,
    explicitSkillInvocation,
  };
}
