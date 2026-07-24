import { fetchChatHistory } from '../../api/chat';
import type {
  A2ADeliveryDescriptor,
  BranchVariant,
  ChatActivityTrace,
  ChatHistoryResponse,
  ChatMessage,
} from '../../api/chat-types';
import { nextMsgId } from '../../lib/chat-helpers';
import type {
  ChatUiMessage,
  TraceChatMessage,
  TraceStep,
} from './chat-ui-message';

export interface ChatHistoryUiData {
  messages: ChatUiMessage[];
  branchFamilies: Map<string, BranchVariant[]>;
  requestedSessionId: string;
  resolvedSessionId: string;
  agentId: string | null;
  bootstrapAutostart: ChatHistoryResponse['bootstrapAutostart'];
}

export const EMPTY_BRANCH_FAMILIES: Map<string, BranchVariant[]> = new Map();

function normalizeAgentIdForComparison(agentId: string | null | undefined) {
  return String(agentId ?? '')
    .trim()
    .toLowerCase();
}

function hydrateA2ADelivery(content: string): A2ADeliveryDescriptor | null {
  const lines = content
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  const deliveryMatch = lines[0]?.match(
    /^(Delivered|Queued for delivery) to `([^`]+)`\.$/,
  );
  if (!deliveryMatch) return null;
  const messageMatch = lines
    .find((line) => line.startsWith('Message: '))
    ?.match(/^Message: `([^`]+)`$/);
  const threadMatch = lines
    .find((line) => line.startsWith('Thread: '))
    ?.match(/^Thread: `([^`]+)`$/);
  const recipientAgentId = deliveryMatch[2]?.trim();
  const messageId = messageMatch?.[1]?.trim();
  const threadId = threadMatch?.[1]?.trim();
  if (!recipientAgentId || !messageId || !threadId) return null;
  return {
    messageId,
    threadId,
    recipientAgentId,
    status: deliveryMatch[1] === 'Delivered' ? 'delivered' : 'pending',
  };
}

function removeResolvedA2ADeliveryStatusMessages(
  messages: ChatUiMessage[],
): ChatUiMessage[] {
  const pendingDeliveryIndexesByRecipient = new Map<string, number[]>();
  const resolvedDeliveryIndexes = new Set<number>();

  messages.forEach((message, index) => {
    if (message.a2aDelivery) {
      const recipient = normalizeAgentIdForComparison(
        message.a2aDelivery.recipientAgentId,
      );
      if (!recipient) return;
      const indexes = pendingDeliveryIndexesByRecipient.get(recipient) ?? [];
      indexes.push(index);
      pendingDeliveryIndexesByRecipient.set(recipient, indexes);
      return;
    }
    if (message.role !== 'assistant') return;
    const sender = normalizeAgentIdForComparison(
      message.assistantPresentation?.agentId,
    );
    if (!sender) return;
    const pendingIndexes = pendingDeliveryIndexesByRecipient.get(sender);
    const deliveryIndex = pendingIndexes?.shift();
    if (deliveryIndex === undefined) return;
    resolvedDeliveryIndexes.add(deliveryIndex);
  });

  if (resolvedDeliveryIndexes.size === 0) return messages;
  return messages.filter((_, index) => !resolvedDeliveryIndexes.has(index));
}

// Rebuild a collapsed (done) trace message from persisted history so a reload
// shows the same draft/thinking/tool activity the live stream rendered.
// Positioned just before its assistant bubble by the caller.
function hydrateActivityTrace(
  trace: ChatActivityTrace | null | undefined,
  sessionId: string,
): TraceChatMessage | null {
  if (!trace || !Array.isArray(trace.steps) || trace.steps.length === 0) {
    return null;
  }
  const steps: TraceStep[] = [];
  for (const step of trace.steps) {
    if (step.kind === 'thinking') {
      steps.push({ kind: 'thinking', text: step.text });
      continue;
    }
    if (step.kind === 'draft') {
      steps.push({ kind: 'draft', text: step.text });
      continue;
    }
    steps.push({
      kind: 'tool',
      toolName: step.toolName,
      status: 'done',
      ...(step.argsPreview ? { argsPreview: step.argsPreview } : {}),
      ...(step.resultPreview ? { resultPreview: step.resultPreview } : {}),
      ...(typeof step.durationMs === 'number'
        ? { durationMs: step.durationMs }
        : {}),
    });
  }
  return {
    id: nextMsgId(),
    role: 'trace',
    content: '',
    sessionId,
    steps,
    done: true,
    startedAt: 0,
    // startedAt is 0, so finishedAt carries the persisted elapsed for the
    // summary's duration; omitted when unknown.
    ...(typeof trace.elapsedMs === 'number'
      ? { finishedAt: trace.elapsedMs }
      : {}),
  };
}

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
  const sessionAgentId = normalizeAgentIdForComparison(raw.agentId);
  let lastUserContent: string | null = null;
  const messages: ChatUiMessage[] = [];
  history.forEach((msg, index) => {
    const nextAssistant = history
      .slice(index + 1)
      .find((candidate) => candidate.role !== 'system');
    const nextAssistantAgentId = normalizeAgentIdForComparison(
      nextAssistant?.agent_id ?? nextAssistant?.assistantPresentation?.agentId,
    );
    const hasAddressedAgent =
      msg.role === 'user' &&
      nextAssistant?.role === 'assistant' &&
      !!nextAssistantAgentId &&
      nextAssistantAgentId !== sessionAgentId;
    const addressedAgentPresentation = hasAddressedAgent
      ? (nextAssistant?.assistantPresentation ?? null)
      : null;
    if (msg.role === 'user') lastUserContent = msg.content;
    const replayContent =
      msg.role === 'user'
        ? msg.content
        : msg.role === 'assistant'
          ? lastUserContent
          : null;
    const chatMessage: ChatMessage = {
      id: nextMsgId(),
      role: msg.role,
      content: msg.content,
      rawContent: msg.content,
      sessionId: resolvedSessionId,
      messageId: msg.id ?? null,
      media: [],
      artifacts: msg.artifacts ?? [],
      replayRequest:
        replayContent !== null ? { content: replayContent, media: [] } : null,
      assistantPresentation: msg.assistantPresentation ?? null,
      addressedAgentPresentation,
      responseRating: msg.response_rating ?? null,
      branchKey:
        msg.id !== undefined && msg.id !== null
          ? (branchKeysByMessageId.get(msg.id) ?? null)
          : null,
      a2aDelivery:
        msg.role === 'assistant' ? hydrateA2ADelivery(msg.content) : null,
      routing: msg.activityTrace?.routing ?? null,
    };
    if (msg.role === 'assistant') {
      const trace = hydrateActivityTrace(msg.activityTrace, resolvedSessionId);
      if (trace) messages.push(trace);
    }
    messages.push(chatMessage);
  });

  return {
    messages: removeResolvedA2ADeliveryStatusMessages(messages),
    branchFamilies,
    requestedSessionId,
    resolvedSessionId,
    agentId: raw.agentId?.trim() || null,
    bootstrapAutostart: raw.bootstrapAutostart ?? null,
  };
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
  userId?: string,
  agentId?: string,
): Promise<ChatHistoryUiData> {
  const raw = await fetchChatHistory(token, sessionId, 80, userId, agentId);
  return buildChatHistoryUiData(raw, sessionId);
}
