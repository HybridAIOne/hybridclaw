import { useCallback, useRef, useState } from 'react';
import { executeCommand } from '../../api/chat';
import type {
  ChatMessage,
  ChatStreamApproval,
  ChatStreamResult,
  MediaItem,
} from '../../api/chat-types';
import { buildApprovalSummary, nextMsgId } from '../../lib/chat-helpers';
import { requestChatStream } from '../../lib/chat-stream';
import { getErrorMessage } from '../../lib/error-message';
import type { ChatUiMessage, ThinkingChatMessage } from './chat-ui-message';

interface ActiveRequest {
  controller: AbortController;
  sessionId: string;
  assistantText: string;
  lastRenderedText: string;
  pendingApproval: ChatStreamApproval | null;
  renderFrame: number;
  stopping: boolean;
}

interface UseChatStreamOptions {
  token: string;
  userId: string;
  getSessionId: () => string;
  setMessages: React.Dispatch<React.SetStateAction<ChatUiMessage[]>>;
  setSessionId: (id: string) => void;
  setError: (err: string) => void;
  refreshRecent: () => void;
}

export interface UseChatStreamReturn {
  /** Returns true when a new send was started, false when rejected due to an active run. */
  sendMessage: (
    content: string,
    media: MediaItem[],
    opts?: { hideUser?: boolean },
  ) => Promise<boolean>;
  stopRequest: () => Promise<void>;
  isStreaming: boolean;
  /** The message ID currently being streamed, or null. */
  streamingMsgId: string | null;
  isActive: () => boolean;
}

export function useChatStream(
  options: UseChatStreamOptions,
): UseChatStreamReturn {
  const {
    token,
    userId,
    getSessionId,
    setMessages,
    setSessionId,
    setError,
    refreshRecent,
  } = options;

  const activeRequestRef = useRef<ActiveRequest | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);

  const sendMessage = useCallback(
    async (
      content: string,
      media: MediaItem[],
      opts?: { hideUser?: boolean },
    ) => {
      if (activeRequestRef.current) {
        setError(
          'Wait for the current run to finish before sending another message.',
        );
        return false;
      }

      const targetSessionId = getSessionId();
      const userMsgId = !opts?.hideUser ? nextMsgId() : null;
      setError('');

      if (userMsgId) {
        const userMsg: ChatMessage = {
          id: userMsgId,
          role: 'user',
          content,
          rawContent: content,
          sessionId: targetSessionId,
          media,
          artifacts: [],
          replayRequest: { content, media },
        };
        setMessages((prev) => [...prev, userMsg]);
      }

      const thinkingId = nextMsgId();
      setMessages((prev) => [
        ...prev,
        {
          id: thinkingId,
          role: 'thinking',
          content: '',
          sessionId: targetSessionId,
        } satisfies ThinkingChatMessage,
      ]);

      const streamId = nextMsgId();
      setStreamingMsgId(streamId);

      const req: ActiveRequest = {
        controller: new AbortController(),
        sessionId: targetSessionId,
        assistantText: '',
        lastRenderedText: '',
        pendingApproval: null,
        renderFrame: 0,
        stopping: false,
      };
      activeRequestRef.current = req;
      setIsStreaming(true);

      const doRender = () => {
        req.renderFrame = 0;
        if (
          req.assistantText === req.lastRenderedText &&
          !req.pendingApproval
        ) {
          return;
        }
        req.lastRenderedText = req.assistantText;

        const role: ChatMessage['role'] = req.pendingApproval
          ? 'approval'
          : 'assistant';
        const text = req.assistantText;
        const approval = req.pendingApproval;

        setMessages((prev) => {
          const withoutThinking = prev.filter((m) => m.id !== thinkingId);
          const existing = withoutThinking.find((m) => m.id === streamId);
          if (existing) {
            return withoutThinking.map((m) =>
              m === existing
                ? { ...m, role, content: text, pendingApproval: approval }
                : m,
            );
          }
          return [
            ...withoutThinking,
            {
              id: streamId,
              role,
              content: text,
              sessionId: req.sessionId,
              artifacts: [],
              pendingApproval: approval,
            },
          ];
        });
      };

      const flushRender = () => {
        if (req.renderFrame) {
          cancelAnimationFrame(req.renderFrame);
          req.renderFrame = 0;
        }
        doRender();
      };

      const scheduleRender = () => {
        if (req.renderFrame) return;
        req.renderFrame = requestAnimationFrame(doRender);
      };

      try {
        const result: ChatStreamResult = await requestChatStream('/api/chat', {
          token,
          body: {
            sessionId: targetSessionId,
            channelId: 'web',
            userId,
            username: 'web',
            content,
            stream: true,
            ...(media.length > 0 ? { media } : {}),
          },
          signal: req.controller.signal,
          callbacks: {
            onTextDelta: (delta) => {
              req.assistantText += delta;
              scheduleRender();
            },
            onApproval: (event) => {
              req.pendingApproval = event;
              if (!req.assistantText.trim()) {
                req.assistantText = buildApprovalSummary(event);
              }
              scheduleRender();
            },
          },
        });

        if (result.status === 'error') {
          throw new Error(result.error ?? 'Unknown error');
        }

        if (result.sessionId) {
          setSessionId(result.sessionId);
        }

        flushRender();

        const finalText = result.result ?? req.assistantText ?? '';
        const finalApproval = req.pendingApproval;
        const finalArtifacts = result.artifacts ?? [];

        setMessages((prev) =>
          prev.map((m) =>
            m.id === streamId
              ? {
                  ...m,
                  role: finalApproval ? 'approval' : 'assistant',
                  content: finalText,
                  messageId: result.assistantMessageId ?? null,
                  artifacts: finalArtifacts,
                  pendingApproval: finalApproval,
                  replayRequest: { content, media },
                }
              : userMsgId &&
                  m.id === userMsgId &&
                  m.role === 'user' &&
                  !m.messageId
                ? {
                    ...m,
                    messageId: result.userMessageId ?? null,
                    sessionId: result.sessionId ?? m.sessionId,
                  }
                : m,
          ),
        );

        refreshRecent();
      } catch (err) {
        if (req.renderFrame) cancelAnimationFrame(req.renderFrame);
        const errorText = getErrorMessage(err);
        setMessages((prev) => {
          const withoutThinking = prev.filter((m) => m.id !== thinkingId);
          if (req.stopping) return withoutThinking;
          return [
            ...withoutThinking,
            {
              id: nextMsgId(),
              role: 'system',
              content: `Error: ${errorText}`,
              sessionId: targetSessionId,
            },
          ];
        });
      } finally {
        activeRequestRef.current = null;
        setIsStreaming(false);
        setStreamingMsgId(null);
      }

      return true;
    },
    [
      token,
      userId,
      getSessionId,
      setMessages,
      setSessionId,
      setError,
      refreshRecent,
    ],
  );

  const stopRequest = useCallback(async () => {
    const req = activeRequestRef.current;
    if (!req || req.stopping) return;
    req.stopping = true;
    try {
      await executeCommand(token, req.sessionId, userId, ['stop']);
    } catch (err) {
      setError(`Failed to stop: ${getErrorMessage(err)}`);
    } finally {
      req.controller.abort();
    }
  }, [token, userId, setError]);

  const isActive = useCallback(() => activeRequestRef.current !== null, []);

  return { sendMessage, stopRequest, isStreaming, streamingMsgId, isActive };
}
