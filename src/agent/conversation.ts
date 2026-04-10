import { normalizeSkillConfigChannelKind } from '../channels/channel-registry.js';
import {
  type HistoryOptimizationStats,
  optimizeHistoryMessagesForPrompt,
} from '../session/token-efficiency.js';
import {
  expandSkillInvocation,
  loadSkills,
  resolveSkillInvocationForTurn,
  type Skill,
  type SkillInvocation,
} from '../skills/skills.js';
import type { ChatMessage } from '../types/api.js';
import {
  buildSystemPromptFromHooks,
  type PromptMode,
  type PromptPartName,
  type PromptRuntimeInfo,
} from './prompt-hooks.js';
import { mergeBlockedToolNames } from './tool-policy.js';

interface HistoryMessage {
  role: string;
  content: string;
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
  expandLatestHistoryUser?: boolean;
  promptMode?: PromptMode;
  includePromptParts?: PromptPartName[];
  omitPromptParts?: PromptPartName[];
  extraSafetyText?: string;
  runtimeInfo?: PromptRuntimeInfo;
  allowedTools?: string[];
  blockedTools?: string[];
  currentUserContent?: string;
}): ConversationContext {
  const {
    agentId,
    sessionSummary,
    retrievedContext,
    history,
    expandLatestHistoryUser = false,
    promptMode = 'full',
    includePromptParts,
    omitPromptParts,
    extraSafetyText,
    runtimeInfo,
    allowedTools,
    blockedTools,
    currentUserContent,
  } = params;
  const mergedBlockedTools = mergeBlockedToolNames({ explicit: blockedTools });
  const skills = loadSkills(
    agentId,
    normalizeSkillConfigChannelKind(runtimeInfo?.channel?.kind),
  );
  const previousUserContent =
    history.find((message) => message.role === 'user')?.content || null;
  const explicitSkillInvocation =
    typeof currentUserContent === 'string' && currentUserContent.trim()
      ? resolveSkillInvocationForTurn({
          content: currentUserContent,
          skills,
          previousUserContent,
        }).invocation
      : null;
  const systemPrompt = buildSystemPromptFromHooks({
    agentId,
    sessionSummary,
    retrievedContext,
    skills,
    explicitSkillInvocation,
    purpose: 'conversation',
    promptMode,
    includePromptParts,
    omitPromptParts,
    extraSafetyText,
    runtimeInfo,
    allowedTools,
    blockedTools: mergedBlockedTools,
  });

  const messages: ChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  const historyMessages = [...history].reverse().map(
    (msg): ChatMessage => ({
      role: msg.role as ChatMessage['role'],
      content: msg.content,
    }),
  );

  if (expandLatestHistoryUser && historyMessages.length > 0) {
    const latest = historyMessages[historyMessages.length - 1];
    if (latest.role === 'user' && typeof latest.content === 'string') {
      latest.content = expandSkillInvocation(latest.content, skills);
    }
  }

  const optimizedHistory = optimizeHistoryMessagesForPrompt(
    historyMessages.map((message) => ({
      role: message.role,
      content: typeof message.content === 'string' ? message.content : '',
    })),
  );

  messages.push(...optimizedHistory.messages);
  return {
    messages,
    skills,
    historyStats: optimizedHistory.stats,
    explicitSkillInvocation,
  };
}
