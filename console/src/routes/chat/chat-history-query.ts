import { fetchChatHistory } from '../../api/chat';
import type {
  BranchVariant,
  ChatHistoryResponse,
  ChatMessage,
} from '../../api/chat-types';
import { nextMsgId } from '../../lib/chat-helpers';
import type { ChatUiMessage } from './chat-ui-message';

export interface ChatHistoryUiData {
  messages: ChatUiMessage[];
  branchFamilies: Map<string, BranchVariant[]>;
  resolvedSessionId: string;
}

export const EMPTY_BRANCH_FAMILIES: Map<string, BranchVariant[]> = new Map();

export function buildChatHistoryUiData(
  raw: ChatHistoryResponse,
  requestedSessionId: string,
): ChatHistoryUiData {
  const resolvedSessionId = raw.sessionId ?? requestedSessionId;

  const branchFamilies = new Map<string, BranchVariant[]>(
    (raw.branchFamilies ?? []).map((bf) => [
      `${bf.anchorSessionId}:${bf.anchorMessageId}`,
      bf.variants,
    ]),
  );

  const branchKeysByMessageId = new Map<number | string, string>();
  for (const [branchKey, variants] of branchFamilies.entries()) {
    const currentVariant = variants.find(
      (variant) => variant.sessionId === resolvedSessionId,
    );
    if (!currentVariant) continue;
    branchKeysByMessageId.set(currentVariant.messageId, branchKey);
  }

  const history = raw.history ?? [];
  let lastUserContent: string | null = null;
  const messages: ChatMessage[] = history.map((msg) => {
    if (msg.role === 'user') lastUserContent = msg.content;
    const replayContent =
      msg.role === 'user'
        ? msg.content
        : msg.role === 'assistant'
          ? lastUserContent
          : null;
    return {
      id: nextMsgId(),
      role: msg.role,
      content: msg.content,
      rawContent: msg.content,
      sessionId: resolvedSessionId,
      messageId: msg.id ?? null,
      media: [],
      artifacts: [],
      replayRequest:
        replayContent !== null ? { content: replayContent, media: [] } : null,
      assistantPresentation: raw.assistantPresentation ?? null,
      branchKey:
        msg.id !== undefined && msg.id !== null
          ? (branchKeysByMessageId.get(msg.id) ?? null)
          : null,
    };
  });

  return { messages, branchFamilies, resolvedSessionId };
}

export function chatHistoryQueryKey(
  token: string,
  sessionId: string,
): readonly ['chat-history', string, string] {
  return ['chat-history', token, sessionId] as const;
}

export async function loadChatHistoryUi(
  token: string,
  sessionId: string,
): Promise<ChatHistoryUiData> {
  const raw = await fetchChatHistory(token, sessionId);
  return buildChatHistoryUiData(raw, sessionId);
}
