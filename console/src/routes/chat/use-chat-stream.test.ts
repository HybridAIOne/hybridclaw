import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatStreamApproval,
  ChatStreamResult,
} from '../../api/chat-types';
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

function makeHarness(initialMessages: ChatUiMessage[] = []) {
  let messages = [...initialMessages];
  let sessionId = 'session-a';
  let error = '';

  return {
    get messages() {
      return messages;
    },
    get sessionId() {
      return sessionId;
    },
    get error() {
      return error;
    },
    setMessages(update: React.SetStateAction<ChatUiMessage[]>) {
      messages = typeof update === 'function' ? update(messages) : update;
    },
    setSessionId(update: React.SetStateAction<string>) {
      sessionId = typeof update === 'function' ? update(sessionId) : update;
    },
    setError(update: React.SetStateAction<string>) {
      error = typeof update === 'function' ? update(error) : update;
    },
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

    const { result } = renderHook(() =>
      useChatStream({
        token: 'test-token',
        userId: 'web-user-1',
        getSessionId: () => 'session-a',
        setMessages: harness.setMessages,
        setSessionId: harness.setSessionId,
        setError: harness.setError,
        refreshRecent: vi.fn(),
      }),
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
        sessionId: 'session-a',
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
          sessionId: 'session-a',
          userMessageId: 'server-user-2',
          assistantMessageId: 'assistant-2',
          result: 'Answer',
        };
      },
    );

    const { result } = renderHook(() =>
      useChatStream({
        token: 'test-token',
        userId: 'web-user-1',
        getSessionId: () => 'session-a',
        setMessages: harness.setMessages,
        setSessionId: harness.setSessionId,
        setError: harness.setError,
        refreshRecent: vi.fn(),
      }),
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
      sessionId: 'session-a',
    });
    expect(assistant).toMatchObject({
      content: 'Answer',
      messageId: 'assistant-2',
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
          sessionId: 'session-a',
          userMessageId: 'server-user-1',
          assistantMessageId: 'assistant-1',
          result: 'Answer',
        };
      },
    );

    const { result } = renderHook(() =>
      useChatStream({
        token: 'test-token',
        userId: 'web-user-1',
        getSessionId: () => 'session-a',
        setMessages: harness.setMessages,
        setSessionId: harness.setSessionId,
        setError: harness.setError,
        refreshRecent: vi.fn(),
      }),
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
      sessionId: 'session-a',
      messageId: 'assistant-1',
    });
  });

  it('removes the thinking placeholder and appends one system error on stream failure', async () => {
    const harness = makeHarness();

    requestChatStreamMock.mockRejectedValue(new Error('Gateway exploded'));

    const { result } = renderHook(() =>
      useChatStream({
        token: 'test-token',
        userId: 'web-user-1',
        getSessionId: () => 'session-a',
        setMessages: harness.setMessages,
        setSessionId: harness.setSessionId,
        setError: harness.setError,
        refreshRecent: vi.fn(),
      }),
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
      sessionId: 'session-a',
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

    const { result } = renderHook(() =>
      useChatStream({
        token: 'test-token',
        userId: 'web-user-1',
        getSessionId: () => 'session-a',
        setMessages: harness.setMessages,
        setSessionId: harness.setSessionId,
        setError: harness.setError,
        refreshRecent: vi.fn(),
      }),
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
        sessionId: 'session-a',
        userMessageId: 'server-user-1',
        assistantMessageId: 'assistant-1',
        result: 'Answer',
      });
      await firstSend;
    });
  });
});
