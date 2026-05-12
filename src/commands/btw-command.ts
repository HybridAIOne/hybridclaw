import { resolveAgentForRequest } from '../agents/agent-registry.js';
import { memoryService } from '../memory/memory-service.js';
import { callAuxiliaryModel } from '../providers/auxiliary.js';
import type { ChatMessage } from '../types/api.js';
import type { Session, StoredMessage } from '../types/session.js';

const BTW_CONTEXT_MESSAGE_LIMIT = 20;
const BTW_MAX_RESPONSE_TOKENS = 512;
const BTW_SYSTEM_PROMPT = [
  'You are answering an ephemeral /btw side question about the current conversation.',
  'Use the conversation only as background context.',
  'Answer only the side question in the last user message.',
  'Do not continue, resume, or complete any unfinished task from the conversation.',
  'Do not emit tool calls, pseudo-tool calls, shell commands, file writes, patches, or code unless the side question explicitly asks for them.',
  'Do not say you will continue the main task after answering.',
  'If the question can be answered briefly, answer briefly.',
].join('\n');

function buildBtwQuestionPrompt(question: string): string {
  return [
    'Answer this side question only.',
    'Ignore any unfinished task in the conversation while answering it.',
    '',
    '<btw_side_question>',
    question.trim(),
    '</btw_side_question>',
  ].join('\n');
}

function toContextChatMessage(message: StoredMessage): ChatMessage | null {
  const role =
    message.role === 'user' || message.role === 'assistant'
      ? message.role
      : null;
  if (!role) return null;
  const content = typeof message.content === 'string' ? message.content : '';
  if (!content.trim()) return null;
  return { role, content };
}

export async function runBtwSideQuestion(
  session: Session,
  question: string,
): Promise<string> {
  const resolved = resolveAgentForRequest({ session });
  const contextMessages = memoryService
    .getRecentMessages(session.id, BTW_CONTEXT_MESSAGE_LIMIT)
    .map(toContextChatMessage)
    .filter((message): message is ChatMessage => message !== null);
  const result = await callAuxiliaryModel({
    task: 'compression',
    messages: [
      { role: 'system', content: BTW_SYSTEM_PROMPT },
      ...contextMessages,
      { role: 'user', content: buildBtwQuestionPrompt(question) },
    ],
    model: resolved.model,
    fallbackChatbotId: resolved.chatbotId,
    agentId: resolved.agentId,
    tools: [],
    maxTokens: BTW_MAX_RESPONSE_TOKENS,
  });
  return result.content;
}
