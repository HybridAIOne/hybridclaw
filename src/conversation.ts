import { buildSessionSummaryPrompt } from './session-maintenance.js';
import { buildSkillsPrompt, expandSkillInvocation, loadSkills, type Skill } from './skills.js';
import type { ChatMessage } from './types.js';
import { buildContextPrompt, loadBootstrapFiles } from './workspace.js';

interface HistoryMessage {
  role: string;
  content: string;
}

export interface ConversationContext {
  messages: ChatMessage[];
  skills: Skill[];
}

export function buildConversationContext(params: {
  agentId: string;
  sessionSummary?: string | null;
  history: HistoryMessage[];
  expandLatestHistoryUser?: boolean;
}): ConversationContext {
  const { agentId, sessionSummary, history, expandLatestHistoryUser = false } = params;
  const skills = loadSkills(agentId);

  const contextFiles = loadBootstrapFiles(agentId);
  const contextPrompt = buildContextPrompt(contextFiles);
  const skillsPrompt = buildSkillsPrompt(skills);
  const summaryPrompt = buildSessionSummaryPrompt(sessionSummary);
  const systemParts = [contextPrompt, summaryPrompt, skillsPrompt].filter(Boolean);

  const messages: ChatMessage[] = [];
  if (systemParts.length > 0) {
    messages.push({ role: 'system', content: systemParts.join('\n\n') });
  }

  const historyMessages = [...history].reverse().map((msg): ChatMessage => ({
    role: msg.role as ChatMessage['role'],
    content: msg.content,
  }));

  if (expandLatestHistoryUser && historyMessages.length > 0) {
    const latest = historyMessages[historyMessages.length - 1];
    if (latest.role === 'user' && typeof latest.content === 'string') {
      latest.content = expandSkillInvocation(latest.content, skills);
    }
  }

  messages.push(...historyMessages);
  return { messages, skills };
}
