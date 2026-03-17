import {
  type HistoryOptimizationStats,
  optimizeHistoryMessagesForPrompt,
} from '../session/token-efficiency.js';
import {
  expandSkillInvocation,
  loadSkills,
  resolveExplicitSkillInvocation,
  type Skill,
} from '../skills/skills.js';
import type { ChatMessage } from '../types.js';
import {
  buildSystemPromptFromHooks,
  type PromptMode,
  type PromptRuntimeInfo,
} from './prompt-hooks.js';

interface HistoryMessage {
  role: string;
  content: string;
}

export interface ConversationContext {
  messages: ChatMessage[];
  skills: Skill[];
  historyStats: HistoryOptimizationStats;
}

export function buildConversationContext(params: {
  agentId: string;
  sessionSummary?: string | null;
  history: HistoryMessage[];
  expandLatestHistoryUser?: boolean;
  promptMode?: PromptMode;
  extraSafetyText?: string;
  runtimeInfo?: PromptRuntimeInfo;
  allowedTools?: string[];
  blockedTools?: string[];
  currentUserContent?: string;
}): ConversationContext {
  const {
    agentId,
    sessionSummary,
    history,
    expandLatestHistoryUser = false,
    promptMode = 'full',
    extraSafetyText,
    runtimeInfo,
    allowedTools,
    blockedTools,
    currentUserContent,
  } = params;
  const skills = loadSkills(agentId, runtimeInfo?.channel?.kind);
  const explicitSkillInvocation =
    typeof currentUserContent === 'string' && currentUserContent.trim()
      ? resolveExplicitSkillInvocation(currentUserContent, skills)
      : null;
  const systemPrompt = buildSystemPromptFromHooks({
    agentId,
    sessionSummary,
    skills,
    explicitSkillInvocation,
    purpose: 'conversation',
    promptMode,
    extraSafetyText,
    runtimeInfo,
    allowedTools,
    blockedTools,
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
  };
}
