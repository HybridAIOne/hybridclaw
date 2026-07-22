import os from 'node:os';

import { DYNAMIC_CONTEXT_MESSAGE_PREFIX } from '../../container/shared/dynamic-context.js';
import { normalizeSkillConfigChannelKind } from '../channels/channel-registry.js';
import { scheduleCloudMemorySync } from '../memory/cloud-memory.js';
import {
  type HistoryOptimizationStats,
  optimizeHistoryMessagesForPrompt,
} from '../session/token-efficiency.js';
import {
  loadSkills,
  resolveSkillInvocationForTurn,
  type Skill,
  type SkillInvocation,
} from '../skills/skills.js';
import type { ChatMessage } from '../types/api.js';
import {
  formatCurrentTime,
  loadDailyMemoryFile,
  loadStaticBootstrapFiles,
  resolveUserTimezoneFromContextFiles,
} from '../workspace.js';
import {
  buildRetrievedContextPrompt,
  buildSessionSummaryPrompt,
  buildSystemPromptBlocksFromHooks,
  type PromptMode,
  type PromptPartName,
  type PromptRuntimeInfo,
  type SkillPromptMode,
} from './prompt-hooks.js';
import { mergeBlockedToolNames } from './tool-policy.js';

interface HistoryMessage {
  role: string;
  content: ChatMessage['content'];
}

const HOSTNAME = sanitizeDynamicContextValue(os.hostname());

function sanitizeDynamicContextValue(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

interface DynamicContextMessageOptions {
  agentId?: string;
  now?: Date;
  retrievedContext?: string | null;
  sessionSummary?: string | null;
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
    dynamicSections.push(
      buildSessionSummaryPrompt(options.sessionSummary),
      buildRetrievedContextPrompt(options.retrievedContext),
    );
  }

  if (agentId) {
    const contextFiles = loadStaticBootstrapFiles(agentId);
    const userTimezone = resolveUserTimezoneFromContextFiles(contextFiles);
    lines.push(`Current Date & Time: ${formatCurrentTime(userTimezone, now)}`);

    const dailyMemoryFile = loadDailyMemoryFile(agentId, {
      now,
      contextFiles,
    });
    if (HOSTNAME) {
      lines.push(`Host: ${HOSTNAME}`);
    }
    lines.push('</context>');

    if (dailyMemoryFile) {
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
  explicitSkillInvocation: SkillInvocation | null;
}

export function buildConversationContext(params: {
  agentId: string;
  sessionSummary?: string | null;
  retrievedContext?: string | null;
  history: HistoryMessage[];
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
  const systemPromptBlocks = buildSystemPromptBlocksFromHooks({
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
    allowedTools,
    blockedTools: mergedBlockedTools,
  });

  const messages: ChatMessage[] = [];
  if (systemPromptBlocks.length > 0) {
    messages.push(
      ...systemPromptBlocks.map(
        (content): ChatMessage => ({ role: 'system', content }),
      ),
    );
  }

  const historyMessages = [...history].reverse().map(
    (msg): ChatMessage => ({
      role: msg.role as ChatMessage['role'],
      content: msg.content,
    }),
  );

  const optimizedHistory = optimizeHistoryMessagesForPrompt(historyMessages);

  messages.push(...optimizedHistory.messages);
  if (systemPromptBlocks.length > 0) {
    messages.push(
      buildDynamicContextMessage({
        agentId,
        retrievedContext,
        sessionSummary,
      }),
    );
  }
  return {
    messages,
    skills,
    historyStats: optimizedHistory.stats,
    explicitSkillInvocation,
  };
}
