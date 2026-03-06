import {
  buildSystemPromptFromHooks,
  type PromptMode,
  type PromptRuntimeInfo,
} from './prompt-hooks.js';
import { expandSkillInvocation, loadSkills, type Skill } from './skills.js';
import {
  type HistoryOptimizationStats,
  optimizeHistoryMessagesForPrompt,
} from './token-efficiency.js';
import type { ChatMessage } from './types.js';

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
  runtimeInfo?: PromptRuntimeInfo;
  allowedTools?: string[];
  blockedTools?: string[];
}): ConversationContext {
  const {
    agentId,
    sessionSummary,
    history,
    expandLatestHistoryUser = false,
    promptMode = 'full',
    runtimeInfo,
    allowedTools,
    blockedTools,
  } = params;
  const skills = loadSkills(agentId);
  const systemPrompt = buildSystemPromptFromHooks({
    agentId,
    sessionSummary,
    skills,
    purpose: 'conversation',
    promptMode,
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
