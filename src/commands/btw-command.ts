import {
  resolveAgentConfig,
  resolveAgentForRequest,
} from '../agents/agent-registry.js';
import { memoryService } from '../memory/memory-service.js';
import { callAuxiliaryModel } from '../providers/auxiliary.js';
import type { ChatMessage } from '../types/api.js';
import type { Session, StoredMessage } from '../types/session.js';

const BTW_CONTEXT_MESSAGE_LIMIT = 20;
const BTW_MAX_RESPONSE_TOKENS = 512;

export interface BtwCommandOutput {
  kind: 'plain' | 'info' | 'error';
  title?: string;
  text: string;
}

export interface RunBtwSideQuestionParams {
  session: Session;
  question: string;
}

function buildBtwSystemPrompt(): string {
  return [
    'You are answering an ephemeral /btw side question about the current conversation.',
    'Use the conversation only as background context.',
    'Answer only the side question in the last user message.',
    'Do not continue, resume, or complete any unfinished task from the conversation.',
    'Do not emit tool calls, pseudo-tool calls, shell commands, file writes, patches, or code unless the side question explicitly asks for them.',
    'Do not say you will continue the main task after answering.',
    'If the question can be answered briefly, answer briefly.',
  ].join('\n');
}

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
  params: RunBtwSideQuestionParams,
): Promise<BtwCommandOutput> {
  const question = params.question.trim();
  if (!question) {
    return {
      kind: 'error',
      title: 'Usage',
      text: 'Usage: `/btw <question>`',
    };
  }

  const resolved = resolveAgentForRequest({ session: params.session });
  const agent = resolveAgentConfig(resolved.agentId);
  const storedMessages = memoryService.getRecentMessages(
    params.session.id,
    BTW_CONTEXT_MESSAGE_LIMIT,
  );
  const contextMessages = storedMessages
    .map(toContextChatMessage)
    .filter((message): message is ChatMessage => message !== null);

  const messages: ChatMessage[] = [
    { role: 'system', content: buildBtwSystemPrompt() },
    ...contextMessages,
    { role: 'user', content: buildBtwQuestionPrompt(question) },
  ];

  try {
    const result = await callAuxiliaryModel({
      task: 'compression',
      messages,
      model: resolved.model,
      fallbackModel: resolved.model,
      fallbackChatbotId: resolved.chatbotId,
      fallbackEnableRag: false,
      fallbackMaxTokens: BTW_MAX_RESPONSE_TOKENS,
      agentId: agent.id,
      tools: [],
      maxTokens: BTW_MAX_RESPONSE_TOKENS,
    });
    const answer = result.content.trim();
    if (!answer) {
      return {
        kind: 'error',
        title: 'BTW Failed',
        text: 'No BTW response generated.',
      };
    }
    return {
      kind: 'info',
      title: 'BTW',
      text: answer,
    };
  } catch (error) {
    return {
      kind: 'error',
      title: 'BTW Failed',
      text: error instanceof Error ? error.message : String(error),
    };
  }
}
