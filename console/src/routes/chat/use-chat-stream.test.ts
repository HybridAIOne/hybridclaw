import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatStreamApproval,
  ChatStreamResult,
} from '../../api/chat-types';
import {
  type ChatHistoryUiData,
  chatHistoryQueryKey,
} from './chat-history-query';
import type { ChatUiMessage } from './chat-ui-message';
import { useChatStream } from './use-chat-stream';

const executeCommandMock = vi.fn();
const requestChatStreamMock = vi.fn();
const nextMsgIdMock = vi.fn();

vi.mock('../../api/chat', () => ({
  executeCommand: (...args: unknown[]) => executeCommandMock(...args),
}));

vi.mock('../../lib/chat-helpers', async () => {
  const actual = await vi.importActual<typeof import('../../lib/chat-helpers')>(
    '../../lib/chat-helpers',
  );
  return {
    ...actual,
    nextMsgId: (...args: Parameters<typeof actual.nextMsgId>) =>
      nextMsgIdMock(...args),
  };
});

vi.mock('../../lib/chat-stream', () => ({
  requestChatStream: (...args: unknown[]) => requestChatStreamMock(...args),
}));

const TOKEN = 'test-token';
const SESSION_ID = 'session-a';

function makeHarness(initialMessages: ChatUiMessage[] = []) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData<ChatHistoryUiData>(
    chatHistoryQueryKey(TOKEN, SESSION_ID),
    {
      messages: [...initialMessages],
      branchFamilies: new Map(),
      resolvedSessionId: SESSION_ID,
    },
  );
  let error = '';
  const correctionMock = vi.fn();

  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  return {
    wrapper,
    get messages(): ChatUiMessage[] {
      return (
        queryClient.getQueryData<ChatHistoryUiData>(
          chatHistoryQueryKey(TOKEN, SESSION_ID),
        )?.messages ?? []
      );
    },
    readSession(id: string): ChatHistoryUiData | undefined {
      return queryClient.getQueryData<ChatHistoryUiData>(
        chatHistoryQueryKey(TOKEN, id),
      );
    },
    get error() {
      return error;
    },
    setError(update: React.SetStateAction<string>) {
      error = typeof update === 'function' ? update(error) : update;
    },
    correctionMock,
  };
}

describe('useChatStream', () => {
  beforeEach(() => {
    executeCommandMock.mockReset();
    requestChatStreamMock.mockReset();
    nextMsgIdMock.mockReset();
    let nextId = 0;
    nextMsgIdMock.mockImplementation(() => `msg-${++nextId}`);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  it('keeps replayRequest on hidden-user approval responses', async () => {
    const approval: ChatStreamApproval = {
      type: 'approval',
      approvalId: 'approval-1',
      prompt: 'Need approval',
      allowSession: true,
      allowAgent: true,
      allowAll: true,
    };
    const harness = makeHarness();

    requestChatStreamMock.mockImplementation(
      async (
        _url: string,
        params: {
          callbacks: {
            onApproval: (event: ChatStreamApproval) => void;
          };
        },
      ): Promise<ChatStreamResult> => {
        params.callbacks.onApproval(approval);
        return {
          status: 'ok',
          assistantMessageId: 'assistant-1',
          result: 'Approval requested',
        };
      },
    );

    const { result } = renderHook(
      () =>
        useChatStream({
          token: TOKEN,
          userId: 'web-user-1',
          getSessionId: () => SESSION_ID,
          setError: harness.setError,
          refreshRecent: vi.fn(),
          onSessionIdCorrection: harness.correctionMock,
        }),
      { wrapper: harness.wrapper },
    );

    await act(async () => {
      await result.current.sendMessage('/approve session approval-1', [], {
        hideUser: true,
      });
    });

    expect(harness.messages).toHaveLength(1);
    expect(harness.messages[0]).toMatchObject({
      role: 'approval',
      content: 'Approval requested',
      messageId: 'assistant-1',
      replayRequest: {
        content: '/approve session approval-1',
        media: [],
      },
      pendingApproval: approval,
    });
  });

  it('backfills the created user message by local id instead of matching on content', async () => {
    const harness = makeHarness([
      {
        id: 'existing-user',
        role: 'user',
        content: 'repeat this',
        rawContent: 'repeat this',
        sessionId: SESSION_ID,
        messageId: null,
        media: [],
        artifacts: [],
        replayRequest: { content: 'repeat this', media: [] },
      },
    ]);

    requestChatStreamMock.mockImplementation(
      async (
        _url: string,
        params: {
          callbacks: {
            onTextDelta: (delta: string) => void;
          };
        },
      ): Promise<ChatStreamResult> => {
        params.callbacks.onTextDelta('Answer');
        return {
          status: 'ok',
          sessionId: SESSION_ID,
          userMessageId: 'server-user-2',
          assistantMessageId: 'assistant-2',
          result: 'Answer',
          assistantPresentation: {
            agentId: 'charly',
            displayName: 'Charly',
            imageUrl: null,
          },
        };
      },
    );

    const { result } = renderHook(
      () =>
        useChatStream({
          token: TOKEN,
          userId: 'web-user-1',
          getSessionId: () => SESSION_ID,
          setError: harness.setError,
          refreshRecent: vi.fn(),
          onSessionIdCorrection: harness.correctionMock,
        }),
      { wrapper: harness.wrapper },
    );

    await act(async () => {
      await result.current.sendMessage('repeat this', []);
    });

    const existingUser = harness.messages.find(
      (msg) => msg.id === 'existing-user',
    );
    const createdUser = harness.messages.find(
      (msg) => msg.role === 'user' && msg.id !== 'existing-user',
    );
    const assistant = harness.messages.find((msg) => msg.role === 'assistant');

    expect(existingUser?.messageId ?? null).toBeNull();
    expect(createdUser).toMatchObject({
      content: 'repeat this',
      messageId: 'server-user-2',
      sessionId: SESSION_ID,
    });
    expect(assistant).toMatchObject({
      content: 'Answer',
      messageId: 'assistant-2',
      assistantPresentation: {
        agentId: 'charly',
        displayName: 'Charly',
      },
      replayRequest: {
        content: 'repeat this',
        media: [],
      },
    });
  });

  it('allocates a separate local id for the streamed assistant message', async () => {
    const harness = makeHarness();

    requestChatStreamMock.mockImplementation(
      async (
        _url: string,
        params: {
          callbacks: {
            onTextDelta: (delta: string) => void;
          };
        },
      ): Promise<ChatStreamResult> => {
        params.callbacks.onTextDelta('Answer');
        return {
          status: 'ok',
          sessionId: SESSION_ID,
          userMessageId: 'server-user-1',
          assistantMessageId: 'assistant-1',
          result: 'Answer',
        };
      },
    );

    const { result } = renderHook(
      () =>
        useChatStream({
          token: TOKEN,
          userId: 'web-user-1',
          getSessionId: () => SESSION_ID,
          setError: harness.setError,
          refreshRecent: vi.fn(),
          onSessionIdCorrection: harness.correctionMock,
        }),
      { wrapper: harness.wrapper },
    );

    await act(async () => {
      await result.current.sendMessage('hello', []);
    });

    expect(nextMsgIdMock).toHaveBeenCalledTimes(3);
    expect(harness.messages).toHaveLength(2);
    expect(harness.messages[0]?.id).toBe('msg-1');
    expect(harness.messages[1]).toMatchObject({
      id: 'msg-3',
      role: 'assistant',
      content: 'Answer',
      sessionId: SESSION_ID,
      messageId: 'assistant-1',
    });
  });

  it('replaces thinking with an assistant message for result-only slash command streams', async () => {
    const harness = makeHarness();

    requestChatStreamMock.mockResolvedValue({
      status: 'success',
      sessionId: SESSION_ID,
      userMessageId: 'server-user-1',
      assistantMessageId: null,
      result: 'Session agent set to `research` (model: `gpt-5`).',
      toolsUsed: [],
    });

    const { result } = renderHook(
      () =>
        useChatStream({
          token: TOKEN,
          userId: 'web-user-1',
          getSessionId: () => SESSION_ID,
          setError: harness.setError,
          refreshRecent: vi.fn(),
          onSessionIdCorrection: harness.correctionMock,
        }),
      { wrapper: harness.wrapper },
    );

    await act(async () => {
      await result.current.sendMessage('/agent switch research', []);
    });

    expect(harness.messages).toHaveLength(2);
    expect(
      harness.messages.find((msg) => msg.role === 'thinking'),
    ).toBeUndefined();
    expect(harness.messages[0]).toMatchObject({
      role: 'user',
      content: '/agent switch research',
      messageId: 'server-user-1',
    });
    expect(harness.messages[1]).toMatchObject({
      id: 'msg-3',
      role: 'assistant',
      content: 'Session agent set to `research` (model: `gpt-5`).',
      messageId: null,
      replayRequest: {
        content: '/agent switch research',
        media: [],
      },
    });
  });

  it('notifies when the server resolves an effective model', async () => {
    const harness = makeHarness();
    const onModelResolved = vi.fn();

    requestChatStreamMock.mockResolvedValue({
      status: 'ok',
      sessionId: SESSION_ID,
      userMessageId: 'server-user-1',
      assistantMessageId: 'assistant-1',
      result: 'Answer',
      model: 'hybridai/grok-4.20-0309-non-reasoning',
    });

    const { result } = renderHook(
      () =>
        useChatStream({
          token: TOKEN,
          userId: 'web-user-1',
          getSessionId: () => SESSION_ID,
          setError: harness.setError,
          refreshRecent: vi.fn(),
          onSessionIdCorrection: harness.correctionMock,
          onModelResolved,
        }),
      { wrapper: harness.wrapper },
    );

    await act(async () => {
      await result.current.sendMessage('hello', []);
    });

    expect(onModelResolved).toHaveBeenCalledWith(
      'hybridai/grok-4.20-0309-non-reasoning',
    );
  });

  it('removes the thinking placeholder and appends one system error on stream failure', async () => {
    const harness = makeHarness();

    requestChatStreamMock.mockRejectedValue(new Error('Gateway exploded'));

    const { result } = renderHook(
      () =>
        useChatStream({
          token: TOKEN,
          userId: 'web-user-1',
          getSessionId: () => SESSION_ID,
          setError: harness.setError,
          refreshRecent: vi.fn(),
          onSessionIdCorrection: harness.correctionMock,
        }),
      { wrapper: harness.wrapper },
    );

    await act(async () => {
      await result.current.sendMessage('hello', []);
    });

    expect(harness.messages).toHaveLength(2);
    expect(harness.messages.map((msg) => msg.role)).toEqual(['user', 'system']);
    expect(
      harness.messages.find((msg) => msg.role === 'thinking'),
    ).toBeUndefined();
    expect(harness.messages[1]).toMatchObject({
      role: 'system',
      content: 'Error: Gateway exploded',
      sessionId: SESSION_ID,
    });
  });

  it('returns false and sets an error when a concurrent send is rejected', async () => {
    const harness = makeHarness();
    let resolveStream: ((value: ChatStreamResult) => void) | null = null;

    requestChatStreamMock.mockImplementation(
      () =>
        new Promise<ChatStreamResult>((resolve) => {
          resolveStream = resolve;
        }),
    );

    const { result } = renderHook(
      () =>
        useChatStream({
          token: TOKEN,
          userId: 'web-user-1',
          getSessionId: () => SESSION_ID,
          setError: harness.setError,
          refreshRecent: vi.fn(),
          onSessionIdCorrection: harness.correctionMock,
        }),
      { wrapper: harness.wrapper },
    );

    let firstSend: Promise<boolean>;
    act(() => {
      firstSend = result.current.sendMessage('hello', []);
    });

    let accepted = true;
    await act(async () => {
      accepted = await result.current.sendMessage(
        '/approve session approval-1',
        [],
        {
          hideUser: true,
        },
      );
    });

    expect(accepted).toBe(false);
    expect(harness.error).toBe(
      'Wait for the current run to finish before sending another message.',
    );
    expect(requestChatStreamMock).toHaveBeenCalledTimes(1);
    expect(
      harness.messages.filter((msg) => msg.role === 'thinking'),
    ).toHaveLength(1);

    await act(async () => {
      resolveStream?.({
        status: 'ok',
        sessionId: SESSION_ID,
        userMessageId: 'server-user-1',
        assistantMessageId: 'assistant-1',
        result: 'Answer',
      });
      await firstSend;
    });
  });

  it('invokes onSessionIdCorrection when the server returns a different sessionId', async () => {
    const harness = makeHarness();

    requestChatStreamMock.mockImplementation(
      async (): Promise<ChatStreamResult> => ({
        status: 'ok',
        sessionId: 'session-b-corrected',
        userMessageId: 'server-user-1',
        assistantMessageId: 'assistant-1',
        result: 'Answer',
      }),
    );

    const { result } = renderHook(
      () =>
        useChatStream({
          token: TOKEN,
          userId: 'web-user-1',
          getSessionId: () => SESSION_ID,
          setError: harness.setError,
          refreshRecent: vi.fn(),
          onSessionIdCorrection: harness.correctionMock,
        }),
      { wrapper: harness.wrapper },
    );

    await act(async () => {
      await result.current.sendMessage('hello', []);
    });

    expect(harness.correctionMock).toHaveBeenCalledWith('session-b-corrected');
  });

  it('writes streamed updates to the session captured at send start, even if getSessionId changes mid-stream', async () => {
    const harness = makeHarness();
    let liveSessionId = SESSION_ID;

    let resolveStream: ((value: ChatStreamResult) => void) | null = null;
    let onTextDelta: ((delta: string) => void) | null = null;
    requestChatStreamMock.mockImplementation(
      (
        _url: string,
        params: { callbacks: { onTextDelta: (delta: string) => void } },
      ) =>
        new Promise<ChatStreamResult>((resolve) => {
          onTextDelta = params.callbacks.onTextDelta;
          resolveStream = resolve;
        }),
    );

    const { result } = renderHook(
      () =>
        useChatStream({
          token: TOKEN,
          userId: 'web-user-1',
          getSessionId: () => liveSessionId,
          setError: harness.setError,
          refreshRecent: vi.fn(),
          onSessionIdCorrection: harness.correctionMock,
        }),
      { wrapper: harness.wrapper },
    );

    let sendPromise: Promise<boolean>;
    act(() => {
      sendPromise = result.current.sendMessage('Hello from A', []);
    });

    // Simulate user navigating to a different session mid-stream.
    liveSessionId = 'session-b';

    // Deliberately streamed after the flip — targetSessionId was captured at
    // send start, so the write must still land on session A's cache.
    act(() => {
      onTextDelta?.('Reply from A');
    });

    await act(async () => {
      resolveStream?.({
        status: 'ok',
        sessionId: SESSION_ID,
        userMessageId: 'server-user-1',
        assistantMessageId: 'assistant-1',
        result: 'Reply from A',
      });
      await sendPromise;
    });

    const sessionA = harness.readSession(SESSION_ID);
    expect(
      sessionA?.messages.some(
        (msg) => msg.role === 'user' && msg.content === 'Hello from A',
      ),
    ).toBe(true);
    expect(
      sessionA?.messages.some(
        (msg) => msg.role === 'assistant' && msg.content === 'Reply from A',
      ),
    ).toBe(true);

    // Session B's cache must not be polluted with session A's stream output.
    expect(harness.readSession('session-b')).toBeUndefined();
  });
});
