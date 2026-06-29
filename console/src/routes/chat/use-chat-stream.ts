import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { executeCommand } from '../../api/chat';
import type {
  AssistantPresentation,
  ChatMessage,
  ChatStreamApproval,
  ChatStreamResult,
  MediaItem,
} from '../../api/chat-types';
import { buildApprovalSummary, nextMsgId } from '../../lib/chat-helpers';
import { requestChatStream } from '../../lib/chat-stream';
import { getErrorMessage } from '../../lib/error-message';
import {
  type ChatHistoryUiData,
  chatHistoryQueryKey,
} from './chat-history-query';
import type { ChatUiMessage, ThinkingChatMessage } from './chat-ui-message';

interface ActiveRequest {
  controller: AbortController;
  sessionId: string;
  messageRole: ChatMessage['role'];
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
  setError: (err: string) => void;
  refreshRecent: () => void;
  onSessionIdCorrection: (serverSessionId: string) => void;
  onModelResolved?: (modelId: string) => void;
  resolveAddressedAgentPresentation?: (
    content: string,
  ) => AssistantPresentation | null;
}

function mutatesAgentList(content: string): boolean {
  const parts = content.trim().split(/\s+/);
  const command = parts[0]?.replace(/^\/+/, '').toLowerCase();
  const subcommand = parts[1]?.toLowerCase();
  return (
    (command === 'agent' || command === 'agents') &&
    (subcommand === 'create' || subcommand === 'install')
  );
}

function parseAgentSwitchTarget(content: string): string | null {
  const parts = content.trim().split(/\s+/);
  const command = parts[0]?.replace(/^\/+/, '').toLowerCase();
  if (command !== 'agent' && command !== 'agents') return null;
  if (parts[1]?.toLowerCase() !== 'switch') return null;
  const target = parts[2]?.trim();
  return target && !/\s/.test(target) ? target : null;
}

function isAgentSwitchSuccess(text: string): boolean {
  return /^Session agent set to\b/i.test(text.trim());
}

function commandStartsBootstrapAutostart(text: string): boolean {
  return /\bBOOTSTRAP\.md\b/i.test(text);
}

export interface UseChatStreamReturn {
  /** Returns true when a new send was started, false when rejected due to an active run. */
  sendMessage: (
    content: string,
    media: MediaItem[],
    opts?: { hideUser?: boolean; appBuild?: boolean; appCategory?: string },
  ) => Promise<boolean>;
  stopRequest: () => Promise<void>;
  isStreaming: boolean;
  /** The message ID currently being streamed, or null. */
  streamingMsgId: string | null;
  /** The session ID currently running, or null when idle. */
  activeSessionId: string | null;
  isActive: () => boolean;
}

export function useChatStream(
  options: UseChatStreamOptions,
): UseChatStreamReturn {
  const {
    token,
    userId,
    getSessionId,
    setError,
    refreshRecent,
    onSessionIdCorrection,
    onModelResolved,
    resolveAddressedAgentPresentation,
  } = options;

  const queryClient = useQueryClient();
  const activeRequestRef = useRef<ActiveRequest | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // Writes must be bound to the sessionId captured when the send started —
  // reading `getSessionId()` at write time would race with navigation and
  // clobber a different session's cache entry.
  const writeMessages = useCallback(
    (
      sessionId: string,
      updater: ChatUiMessage[] | ((prev: ChatUiMessage[]) => ChatUiMessage[]),
    ) => {
      const key = chatHistoryQueryKey(token, sessionId);
      queryClient.setQueryData<ChatHistoryUiData>(key, (prev) => {
        const prevMessages = prev?.messages ?? [];
        const nextMessages =
          typeof updater === 'function' ? updater(prevMessages) : updater;
        if (nextMessages === prevMessages) return prev;
        return {
          messages: nextMessages,
          branchFamilies: prev?.branchFamilies ?? new Map(),
          requestedSessionId: prev?.requestedSessionId ?? sessionId,
          resolvedSessionId: prev?.resolvedSessionId ?? sessionId,
          agentId: prev?.agentId ?? null,
          bootstrapAutostart: prev?.bootstrapAutostart ?? null,
        };
      });
    },
    [queryClient, token],
  );

  const sendMessage = useCallback(
    async (
      content: string,
      media: MediaItem[],
      opts?: { hideUser?: boolean; appBuild?: boolean; appCategory?: string },
    ) => {
      if (activeRequestRef.current) {
        setError(
          'Wait for the current run to finish before sending another message.',
        );
        return false;
      }

      const targetSessionId = getSessionId();
      const setMessages = (
        updater: ChatUiMessage[] | ((prev: ChatUiMessage[]) => ChatUiMessage[]),
      ) => writeMessages(targetSessionId, updater);
      const userMsgId = !opts?.hideUser ? nextMsgId() : null;
      setError('');

      if (userMsgId) {
        const addressedAgentPresentation =
          resolveAddressedAgentPresentation?.(content) ?? null;
        const userMsg: ChatMessage = {
          id: userMsgId,
          role: 'user',
          content,
          rawContent: content,
          sessionId: targetSessionId,
          media,
          artifacts: [],
          replayRequest: { content, media },
          addressedAgentPresentation,
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
        messageRole: 'assistant',
        assistantText: '',
        lastRenderedText: '',
        pendingApproval: null,
        renderFrame: 0,
        stopping: false,
      };
      activeRequestRef.current = req;
      setActiveSessionId(targetSessionId);
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

        const text = req.assistantText;
        const approval = req.pendingApproval;

        setMessages((prev) => {
          const withoutThinking = prev.filter((m) => m.id !== thinkingId);
          const existing = withoutThinking.find((m) => m.id === streamId);
          if (existing) {
            return withoutThinking.map((m) =>
              m === existing
                ? {
                    ...m,
                    role: req.messageRole,
                    content: text,
                    pendingApproval: approval,
                  }
                : m,
            );
          }
          return [
            ...withoutThinking,
            {
              id: streamId,
              role: req.messageRole,
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
            ...(opts?.appBuild ? { appBuild: true } : {}),
            ...(opts?.appCategory ? { appCategory: opts.appCategory } : {}),
          },
          signal: req.controller.signal,
          callbacks: {
            onTextDelta: (delta) => {
              req.assistantText += delta;
              scheduleRender();
            },
            onApproval: (event) => {
              req.pendingApproval = event;
              req.messageRole = 'approval';
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

        if (result.sessionId && result.sessionId !== targetSessionId) {
          onSessionIdCorrection(result.sessionId);
        }

        const resolvedModel = result.model?.trim();
        if (resolvedModel) {
          onModelResolved?.(resolvedModel);
        }

        flushRender();

        const finalText = result.result ?? req.assistantText ?? '';
        const finalApproval = req.pendingApproval;
        const finalArtifacts = result.artifacts ?? [];
        const addressedAgentId =
          typeof result.addressEnvelope?.to === 'string'
            ? result.addressEnvelope.to
            : null;
        if (!result.messageRole) {
          throw new Error('Gateway chat result is missing messageRole.');
        }
        const finalRole: ChatMessage['role'] = result.messageRole;
        // A slash command that produced no visible output (and no artifacts)
        // leaves no bubble — like a shell command that succeeds silently.
        const isSilentCommand =
          finalRole === 'command' &&
          finalText.trim().length === 0 &&
          finalArtifacts.length === 0;
        const buildFinalizedMessage = (
          id: string,
          sessionId: string,
          base?: ChatUiMessage,
        ): ChatUiMessage => ({
          ...base,
          id,
          role: finalRole,
          content: finalText,
          sessionId,
          messageId: result.assistantMessageId ?? null,
          artifacts: finalArtifacts,
          assistantPresentation: result.assistantPresentation ?? null,
          pendingApproval: finalApproval,
          responseRating: null,
          replayRequest: { content, media },
        });

        setMessages((prev) => {
          const withoutThinking = prev.filter((m) => m.id !== thinkingId);
          const hasAssistant = withoutThinking.some((m) => m.id === streamId);
          const finalizeMessage = (m: ChatUiMessage): ChatUiMessage => {
            if (m.id === streamId) {
              return buildFinalizedMessage(
                streamId,
                result.sessionId ?? m.sessionId,
                m,
              );
            }
            if (userMsgId && m.id === userMsgId && m.role === 'user') {
              return {
                ...m,
                addressedAgentPresentation: addressedAgentId
                  ? (result.assistantPresentation ?? null)
                  : null,
                messageId: m.messageId ?? result.userMessageId ?? null,
                sessionId: result.sessionId ?? m.sessionId,
              };
            }
            return m;
          };

          // Drop the placeholder bubble for a silent command, but still
          // finalize the user echo (e.g. its server messageId).
          if (isSilentCommand) {
            return withoutThinking
              .filter((m) => m.id !== streamId)
              .map(finalizeMessage);
          }

          const finalized = withoutThinking.map(finalizeMessage);
          if (hasAssistant) return finalized;

          return [
            ...finalized,
            buildFinalizedMessage(streamId, result.sessionId ?? req.sessionId),
          ];
        });

        refreshRecent();
        const switchedAgentId =
          finalRole === 'command' && isAgentSwitchSuccess(finalText)
            ? parseAgentSwitchTarget(content)
            : null;
        if (switchedAgentId) {
          const switchedSessionId = result.sessionId ?? targetSessionId;
          const switchedHistoryKey = chatHistoryQueryKey(
            token,
            switchedSessionId,
          );
          queryClient.setQueryData<ChatHistoryUiData>(
            switchedHistoryKey,
            (prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                agentId: switchedAgentId,
                bootstrapAutostart: commandStartsBootstrapAutostart(finalText)
                  ? {
                      status: 'starting',
                      fileName: 'BOOTSTRAP.md',
                    }
                  : prev.bootstrapAutostart,
              };
            },
          );
          void queryClient.invalidateQueries({
            queryKey: switchedHistoryKey,
            refetchType: 'none',
          });
          void queryClient.invalidateQueries({
            queryKey: ['chat-context', token, switchedSessionId],
          });
        }
        if (finalRole === 'command' && mutatesAgentList(content)) {
          void queryClient.invalidateQueries({
            queryKey: ['agents-list', token],
          });
        }
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
        setActiveSessionId(null);
        setIsStreaming(false);
        setStreamingMsgId(null);
      }

      return true;
    },
    [
      token,
      userId,
      getSessionId,
      writeMessages,
      onSessionIdCorrection,
      onModelResolved,
      resolveAddressedAgentPresentation,
      queryClient,
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

  return {
    sendMessage,
    stopRequest,
    isStreaming,
    streamingMsgId,
    activeSessionId,
    isActive,
  };
}
