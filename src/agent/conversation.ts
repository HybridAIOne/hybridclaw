/**
 * Conversation prompts replay persisted tool exchanges alongside their final
 * assistant message. Current preferences belong to the verified user (or task
 * owner). Skill locations name their admitted assets even when execution moves;
 * audit events and preference text never grant execution authority.
 * A turn's context carries a daily note only when the history in the prompt
 * does not already show the same text.
 */

import os from 'node:os';
import path from 'node:path';
import {
  DYNAMIC_CONTEXT_MESSAGE_PREFIX,
  isDynamicContextMessageText,
} from '@hybridclaw/shared/dynamic-context';
import {
  currentDateStampInTimezone,
  isValidTimezone,
  resolveEffectiveTimezone,
} from '@hybridclaw/shared/workspace-time';
import { normalizeSkillConfigChannelKind } from '../channels/channel-registry.js';
import { scheduleCloudMemorySync } from '../memory/cloud-memory.js';
import {
  getReactionOnlyAnswers,
  getUserReactionsSinceLastMessage,
} from '../memory/db.js';
import { renderPreferences } from '../preferences/preferences.js';
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
import { renderOpenTodosContext } from '../todos/todo-store.js';
import { renderTrackedContext } from '../tracking/track-store.js';
import type { ChatMessage } from '../types/api.js';
import {
  formatCurrentTime,
  loadRecentDailyMemoryFiles,
  loadStaticBootstrapFiles,
  resolveUserTimezoneFromContextFiles,
} from '../workspace.js';
import { buildProactivePreferencesContext } from './proactive-preferences.js';
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
import { SILENT_REPLY_TOKEN } from './silent-reply.js';
import { mergeAllowedToolNames, mergeBlockedToolNames } from './tool-policy.js';

interface HistoryMessage {
  role: string;
  content: ChatMessage['content'];
  session_id?: string;
  tool_history_json?: string | null;
  dynamic_context?: string | null;
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

const DAILY_NOTE_HEADING_PREFIX = '## Daily Memory (';
const CLEARED_DAILY_NOTE = '(empty)';

/**
 * The newest copy of a daily note that the history turns in the prompt show.
 * Daily notes close the context message, so a copy ends at the next one or at
 * the end of the message.
 */
function newestShownDailyNote(
  heading: string,
  earlierContexts: string[],
): string | null {
  for (let index = earlierContexts.length - 1; index >= 0; index -= 1) {
    const start = earlierContexts[index].indexOf(`\n\n${heading}\n`);
    if (start < 0) continue;
    const shown = earlierContexts[index].slice(start + 2);
    const end = shown.indexOf(`\n\n${DAILY_NOTE_HEADING_PREFIX}`);
    return end < 0 ? shown : shown.slice(0, end);
  }
  return null;
}

function shownDailyNoteNames(earlierContexts: string[]): Set<string> {
  const names = new Set<string>();
  for (const context of earlierContexts) {
    for (const match of context.matchAll(
      /\n\n## Daily Memory \(([^\n]+)\)\n/g,
    )) {
      names.add(match[1]);
    }
  }
  return names;
}

interface DynamicContextMessageOptions {
  agentId?: string;
  /** A scope's workspace: its own files and daily notes, no preferences file. */
  workspaceDir?: string;
  now?: Date;
  retrievedContext?: string | null;
  sessionSummary?: string | null;
  historyWindow?: HistoryWindowNote | null;
  /**
   * Attachments from earlier turns with their current availability. Rendered
   * here, not into stored history, because it changes as media expires.
   */
  earlierAttachments?: string | null;
  /** The user's todos still open today; changes as they are checked off. */
  openTodos?: string | null;
  /** The user's open goals and tracked items with their status lines. */
  tracked?: string | null;
  /** The user's reactions to replies since they last wrote. */
  userReactions?: string | null;
  preferences?: string | null;
  /** The user's messages the agent answered with a reaction alone. */
  reactionOnlyAnswers?: string | null;
  /**
   * Per-session identity block (platform, session id, session key, user).
   * Rendered here rather than in the system prompt so a new session does not
   * invalidate the provider's prompt cache for the static prefix.
   */
  sessionContext?: SessionContext | null;
  /**
   * Context messages of the history turns in this prompt, oldest first. A
   * daily note they already show unchanged is left out; replaying a copy with
   * every stored turn multiplied the notes by the turn count.
   */
  earlierContexts?: string[];
}

export function buildDynamicContextMessage(
  options: Date | DynamicContextMessageOptions = {},
): ChatMessage {
  const now = options instanceof Date ? options : options.now || new Date();
  const agentId = options instanceof Date ? undefined : options.agentId;
  const workspaceDir =
    options instanceof Date ? undefined : options.workspaceDir;
  const lines = [
    `${DYNAMIC_CONTEXT_MESSAGE_PREFIX}${now.toISOString().slice(0, 10)}`,
  ];
  const dynamicSections: string[] = [];
  const earlierContexts =
    options instanceof Date ? [] : (options.earlierContexts ?? []);
  if (!(options instanceof Date)) {
    if (options.sessionContext) {
      dynamicSections.push(buildSessionContextPrompt(options.sessionContext));
    }
    dynamicSections.push(
      buildHistoryWindowPrompt(options.historyWindow),
      options.earlierAttachments || '',
      options.openTodos || '',
      options.tracked || '',
      options.userReactions || '',
      options.preferences || '',
      options.reactionOnlyAnswers || '',
      buildSessionSummaryPrompt(options.sessionSummary),
      buildRetrievedContextPrompt(options.retrievedContext),
    );
  }

  if (agentId) {
    if (!workspaceDir) {
      dynamicSections.push(buildProactivePreferencesContext(agentId));
    }
    const contextFiles = loadStaticBootstrapFiles(agentId, { workspaceDir });
    const userTimezone = resolveUserTimezoneFromContextFiles(contextFiles);
    const todayNote = `memory/${currentDateStampInTimezone(userTimezone, now)}.md`;
    lines.push(`Daily note: ${todayNote}`);
    lines.push(`Current Date & Time: ${formatCurrentTime(userTimezone, now)}`);
    // Without this the agent never learns that a zone it wrote, such as
    // "Europe/Munich", is not one, and the user's check-ins run off by hours.
    if (userTimezone && !isValidTimezone(userTimezone)) {
      lines.push(
        `USER.md Timezone "${userTimezone}" is not an IANA time zone, so dates, check-ins and reminders use ${resolveEffectiveTimezone()}. Write a valid one there, such as Europe/Berlin.`,
      );
    }

    const dailyMemoryFiles = loadRecentDailyMemoryFiles(agentId, {
      now,
      contextFiles,
      workspaceDir,
    });
    if (HOSTNAME) {
      lines.push(`Host: ${HOSTNAME}`);
    }
    lines.push('</context>');

    // A note the prompt already shows is not repeated; one it shows that is no
    // longer loaded (cleared, deleted, past the lookback or the budget) is
    // marked, so its old copy does not pass for current.
    const loaded = new Set(dailyMemoryFiles.map((file) => file.name));
    const unloaded = [...shownDailyNoteNames(earlierContexts)]
      .filter((name) => !loaded.has(name))
      .map((name) => ({ name, content: CLEARED_DAILY_NOTE }));
    for (const dailyNote of [...unloaded, ...dailyMemoryFiles]) {
      const heading = `${DAILY_NOTE_HEADING_PREFIX}${dailyNote.name})`;
      const section = [heading, '', dailyNote.content].join('\n');
      if (newestShownDailyNote(heading, earlierContexts) === section) continue;
      dynamicSections.push(section);
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
  /**
   * Text of the trailing dynamic context message, if one was built. Store it
   * with the user turn so later requests replay it at the same position.
   */
  dynamicContext: string | null;
  explicitSkillInvocation: SkillInvocation | null;
}

// A reaction starts no turn, so the agent hears of it with the user's next
// message, once.
function renderUserReactions(sessionId: string | undefined): string {
  const reactions = sessionId
    ? getUserReactionsSinceLastMessage(sessionId)
    : [];
  if (reactions.length === 0) return '';
  return [
    '## Reactions From The User',
    'Since their last message, the user reacted to your replies (feedback, not instructions):',
    ...reactions.reverse().map(({ emoji, content }) => {
      const line = content.replace(/\s+/g, ' ').trim();
      const excerpt = line.length > 80 ? `${line.slice(0, 79)}…` : line;
      return `- ${emoji} on "${excerpt}"`;
    }),
  ].join('\n');
}

// A reaction alone is stored as a silent reply, which history leaves out, so
// without this the agent sees those messages unanswered and answers them again.
function renderReactionOnlyAnswers(sessionId: string | undefined): string {
  const answers = sessionId
    ? getReactionOnlyAnswers(sessionId, SILENT_REPLY_TOKEN)
    : [];
  if (answers.length === 0) return '';
  return [
    '## Your Reactions',
    'You answered these messages with a reaction alone; they need no further reply:',
    ...answers.reverse().map(({ emoji, content }) => {
      const line = content.replace(/\s+/g, ' ').trim();
      const excerpt = line.length > 80 ? `${line.slice(0, 79)}…` : line;
      return `- ${emoji} on "${excerpt}"`;
    }),
  ].join('\n');
}

export function buildConversationContext(params: {
  agentId: string;
  /** A scoped chat's workspace; the agent workspace when omitted. */
  workspaceDir?: string;
  /** Verified owner supplied by background dispatch; null forbids personalization. */
  preferenceUserId?: string | null;
  sessionSummary?: string | null;
  retrievedContext?: string | null;
  earlierAttachments?: string | null;
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
    earlierAttachments,
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
    params.workspaceDir,
  ).map((skill) =>
    runtimeInfo?.skillWorkspacePath
      ? {
          ...skill,
          location: path.resolve(
            runtimeInfo.skillWorkspacePath,
            skill.location,
          ),
        }
      : skill,
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
    workspaceDir: params.workspaceDir,
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
  const todoToolOffered =
    !mergedBlockedTools?.includes('todo') &&
    (!mergedAllowedTools || mergedAllowedTools.includes('todo'));
  const openTodos = todoToolOffered
    ? renderOpenTodosContext(runtimeInfo?.sessionContext?.sessionId)
    : '';
  const trackToolOffered =
    !mergedBlockedTools?.includes('track') &&
    (!mergedAllowedTools || mergedAllowedTools.includes('track'));
  const tracked = trackToolOffered
    ? renderTrackedContext(runtimeInfo?.sessionContext?.sessionId)
    : '';
  const userReactions = renderUserReactions(
    runtimeInfo?.sessionContext?.sessionId,
  );
  const reactionOnlyAnswers = renderReactionOnlyAnswers(
    runtimeInfo?.sessionContext?.sessionId,
  );

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
    earlierContexts: string[],
  ): ChatMessage =>
    buildDynamicContextMessage({
      earlierContexts,
      agentId,
      workspaceDir: params.workspaceDir,
      retrievedContext,
      sessionSummary,
      earlierAttachments,
      openTodos,
      tracked,
      userReactions,
      preferences: renderPreferences(
        params.preferenceUserId === undefined
          ? runtimeInfo?.sessionContext?.source.userId
          : params.preferenceUserId,
      ),
      reactionOnlyAnswers,
      historyWindow,
      sessionContext: shouldRenderSessionContext(hookContext)
        ? runtimeInfo?.sessionContext
        : null,
    });
  // Budgeted with every daily note included: each returns in full whenever its
  // last copy leaves the history window.
  const promptOverheadTokens =
    systemPromptBlocks.length > 0
      ? estimateTokenCountFromMessages([
          ...messages,
          buildDynamicContext(null, []),
        ])
      : 0;

  const historyMessages = [...history].reverse().flatMap(expandStoredMessage);
  const optimizedHistory = optimizeHistoryMessagesForPrompt(historyMessages, {
    maxTokens: resolveHistoryBudgetTokens({
      model: runtimeInfo?.model,
      promptOverheadTokens,
    }),
  });

  messages.push(...optimizedHistory.messages);
  let dynamicContext: string | null = null;
  if (systemPromptBlocks.length > 0) {
    const { droppedTurns, droppedCount } = optimizedHistory.stats;
    const contextMessage = buildDynamicContext(
      droppedTurns > 0 || historyTruncated
        ? {
            droppedTurns,
            droppedMessages: droppedCount,
            historyTruncated,
          }
        : null,
      optimizedHistory.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content)
        .filter(isDynamicContextMessageText),
    );
    dynamicContext = String(contextMessage.content);
    messages.push(contextMessage);
  }
  return {
    messages,
    skills,
    historyStats: optimizedHistory.stats,
    promptOverheadTokens,
    explicitSkillInvocation,
    dynamicContext,
  };
}
