/**
 * Pagination preserves stored-message identity and live-session cache ownership.
 * These checks exercise history browsing, not model context or retention.
 */
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useCallback } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatHistoryResponse } from '../../api/chat-types';
import {
  buildChatHistoryUiData,
  type ChatHistoryUiData,
  chatHistoryQueryKey,
} from './chat-history-query';
import { ChatHistoryViewport } from './chat-history-viewport';
import { useStickToBottom } from './use-stick-to-bottom';

const fetchHistory = vi.hoisted(() => vi.fn());
vi.mock('../../api/chat', () => ({ fetchChatHistory: fetchHistory }));

function page(
  ids: number[],
  nextCursor: string | null,
  sessionId = 'session-a',
): ChatHistoryResponse {
  return {
    sessionId,
    nextCursor,
    history: ids.map((id) => ({ id, role: 'user', content: `Message ${id}` })),
  };
}

function Harness({ sessionId = 'session-a', initial = page([3, 4, 5], '3') }) {
  const { data } = useQuery({
    queryKey: chatHistoryQueryKey('test-token', sessionId),
    queryFn: () => Promise.resolve(buildChatHistoryUiData(initial, sessionId)),
    initialData: () => buildChatHistoryUiData(initial, sessionId),
    enabled: false,
  });
  const stick = useStickToBottom();
  const scrollRef = useCallback(
    (element: HTMLDivElement | null) => {
      if (element) {
        Object.defineProperties(element, {
          scrollHeight: {
            configurable: true,
            get: () =>
              element.querySelectorAll('[data-message]').length * 100 + 40,
          },
          clientHeight: { configurable: true, value: 200 },
        });
      }
      stick.scrollRef(element);
    },
    [stick.scrollRef],
  );
  return (
    <ChatHistoryViewport
      key={sessionId}
      token="test-token"
      sessionId={sessionId}
      userId="user_a"
      history={data}
      scrollRef={scrollRef}
      contentRef={stick.contentRef}
      onPrepend={stick.pauseFollowing}
    >
      {data.messages.map((message) => (
        <div data-message={message.messageId} key={message.id}>
          {message.content}
        </div>
      ))}
    </ChatHistoryViewport>
  );
}

function setup(initial?: ChatHistoryResponse) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <Harness initial={initial} />
    </QueryClientProvider>,
  );
  const scroller = screen.getByText('Message 3').parentElement
    ?.parentElement as HTMLDivElement;
  return { client, scroller, ...view };
}

beforeEach(() => {
  fetchHistory.mockReset();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      const index = this.hasAttribute('data-message')
        ? Array.from(this.parentElement?.children ?? []).indexOf(this)
        : -1;
      const scroller = this.parentElement?.parentElement;
      const top = index < 0 ? 0 : 40 + index * 100 - (scroller?.scrollTop ?? 0);
      return {
        x: 0,
        y: top,
        top,
        bottom: top + (index < 0 ? 200 : 100),
        left: 0,
        right: 100,
        height: index < 0 ? 200 : 100,
        width: 100,
        toJSON: () => ({}),
      };
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

it('loads by button, preserves the visible DOM node and position, and keeps concurrent live messages', async () => {
  let resolve!: (value: ChatHistoryResponse) => void;
  fetchHistory.mockReturnValue(
    new Promise<ChatHistoryResponse>((done) => {
      resolve = done;
    }),
  );
  const { client, scroller } = setup();
  const anchor = screen.getByText('Message 3');
  scroller.scrollTop = 100;
  const oldTop = anchor.getBoundingClientRect().top;
  fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
  expect(
    (
      screen.getByRole('button', {
        name: 'Loading older messages…',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.scroll(scroller);
  expect(fetchHistory).toHaveBeenCalledTimes(1);
  act(() => {
    client.setQueryData<ChatHistoryUiData>(
      chatHistoryQueryKey('test-token', 'session-a'),
      (current) =>
        current
          ? {
              ...current,
              messages: [
                ...current.messages,
                ...buildChatHistoryUiData(page([6], null), 'session-a')
                  .messages,
              ],
            }
          : current,
    );
  });
  await screen.findByText('Message 6');
  await act(async () => {
    resolve(page([1, 2], null));
  });
  await screen.findByText('Message 1');
  expect(screen.getByText('Message 3')).toBe(anchor);
  expect(anchor.getBoundingClientRect().top).toBe(oldTop);
  expect(scroller.scrollTop).toBe(300);
  expect(screen.getByText('Message 6')).toBeTruthy();
  expect(screen.getByText('Beginning of conversation')).toBeTruthy();
  expect(fetchHistory).toHaveBeenCalledWith(
    'test-token',
    'session-a',
    80,
    'user_a',
    undefined,
    '3',
  );
});

it('loads when scrolling upward near the top, shows errors, and retries only when requested', async () => {
  fetchHistory
    .mockRejectedValueOnce(new Error('Network unavailable'))
    .mockResolvedValueOnce(page([1, 2], null));
  const { scroller } = setup();
  expect(fetchHistory).not.toHaveBeenCalled();
  act(() => {
    scroller.scrollTop = 40;
    fireEvent.scroll(scroller);
  });
  await screen.findByRole('alert');
  act(() => {
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
  });
  expect(fetchHistory).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
  await screen.findByText('Message 1');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(fetchHistory).toHaveBeenCalledTimes(2);
});

it('lets readers continue across an empty filtered page', async () => {
  fetchHistory
    .mockResolvedValueOnce(page([], '1'))
    .mockResolvedValueOnce(page([1, 2], null));
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
  await waitFor(() =>
    expect(
      (
        screen.getByRole('button', {
          name: 'Load older messages',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
  await screen.findByText('Message 1');
  expect(fetchHistory).toHaveBeenLastCalledWith(
    'test-token',
    'session-a',
    80,
    'user_a',
    undefined,
    '1',
  );
});

it('ignores an old request after switching sessions', async () => {
  let resolve!: (value: ChatHistoryResponse) => void;
  fetchHistory.mockReturnValue(
    new Promise<ChatHistoryResponse>((done) => {
      resolve = done;
    }),
  );
  const { client, rerender } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
  rerender(
    <QueryClientProvider client={client}>
      <Harness sessionId="session-b" initial={page([9], null, 'session-b')} />
    </QueryClientProvider>,
  );
  await act(async () => {
    resolve(page([1, 2], null));
  });
  expect(screen.getByText('Message 9')).toBeTruthy();
  expect(screen.queryByText('Message 1')).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Load older messages' }),
  ).toBeNull();
});
