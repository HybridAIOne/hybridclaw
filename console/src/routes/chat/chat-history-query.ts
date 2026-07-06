import { fetchChatHistory } from '../../api/chat';
import type {
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

// Rebuild a collapsed (done) trace message from persisted history so a reload
// shows thinking/tool activity without replaying intermediate assistant drafts.
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
  if (steps.length === 0) return null;
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
    };
    if (msg.role === 'assistant') {
      const trace = hydrateActivityTrace(msg.activityTrace, resolvedSessionId);
      if (trace) messages.push(trace);
    }
    messages.push(chatMessage);
  });

  return {
    messages,
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
