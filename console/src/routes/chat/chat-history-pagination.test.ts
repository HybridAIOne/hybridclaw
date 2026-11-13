/**
 * Pagination preserves stored-message identity and live-session cache ownership.
 * These checks exercise history browsing, not model context or retention.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChatHistoryResponse } from '../../api/chat-types';
import {
  buildChatHistoryUiData,
  loadChatHistoryUi,
  prependChatHistory,
  retainOlderChatHistory,
} from './chat-history-query';

const fetchHistory = vi.hoisted(() => vi.fn());
vi.mock('../../api/chat', () => ({ fetchChatHistory: fetchHistory }));

function page(ids: number[], nextCursor: string | null) {
  return buildChatHistoryUiData(
    {
      sessionId: 'session-a',
      nextCursor,
      history: ids.map((id) => ({
        id,
        role: id % 2 ? 'user' : 'assistant',
        content: `Message ${id}`,
      })),
    },
    'session-a',
  );
}

describe('chat history pages', () => {
  it('keeps the initial 80-message request and includes the cursor only for older pages', async () => {
    fetchHistory.mockResolvedValue({
      sessionId: 'session-a',
      history: [],
      nextCursor: '12',
    } satisfies ChatHistoryResponse);
    await loadChatHistoryUi('test-token', 'session-a', 'user_a', 'main');
    expect(fetchHistory).toHaveBeenLastCalledWith(
      'test-token',
      'session-a',
      80,
      'user_a',
      'main',
    );
    const older = await loadChatHistoryUi(
      'test-token',
      'session-a',
      'user_a',
      'main',
      '12',
    );
    expect(fetchHistory).toHaveBeenLastCalledWith(
      'test-token',
      'session-a',
      80,
      'user_a',
      'main',
      '12',
    );
    expect(older.nextCursor).toBe('12');
  });

  it('deduplicates pages, keeps newer message IDs, and completes replay context across a page boundary', () => {
    const current = page([2, 3, 4], '2');
    const result = prependChatHistory(page([1, 2], null), current);
    expect(result.messages.map((message) => message.messageId)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(result.messages[1].id).toBe(current.messages[0].id);
    expect(result.messages[1].replayRequest?.content).toBe('Message 1');
    expect(result.nextCursor).toBeNull();
  });

  it('retains older pages and their traces when refreshing the latest window', () => {
    const old = page([1, 2, 3, 4], '1');
    old.messages.splice(1, 0, {
      id: `${old.messages[1].id}:trace`,
      messageId: 2,
      sessionId: 'session-a',
      role: 'trace',
      content: '',
      steps: [],
      done: true,
      startedAt: 0,
    });
    old.hasLoadedOlder = true;
    const result = retainOlderChatHistory(page([3, 4, 5, 6], '3'), old);
    expect(
      result.messages.map((message) => [message.role, message.messageId]),
    ).toEqual([
      ['user', 1],
      ['trace', 2],
      ['assistant', 2],
      ['user', 3],
      ['assistant', 4],
      ['user', 5],
      ['assistant', 6],
    ]);
    expect(result.nextCursor).toBe('1');
  });

  it('advances an empty filtered page and ignores a page for another resolved session', () => {
    const current = page([5, 6], '5');
    expect(prependChatHistory(page([], '2'), current)).toMatchObject({
      nextCursor: '2',
      messages: current.messages,
    });
    const other = { ...page([1, 2], null), resolvedSessionId: 'session-b' };
    expect(prependChatHistory(other, current)).toBe(current);
  });

  it('drops cached older pages when a refreshed response contains the entire stored conversation', () => {
    const previous = { ...page([1, 2, 3, 4], null), hasLoadedOlder: true };
    const cleared = page([], null);
    expect(retainOlderChatHistory(cleared, previous)).toBe(cleared);
    const replacement = page([5, 6], null);
    expect(retainOlderChatHistory(replacement, previous)).toBe(replacement);
  });

  it('uses stable message and trace IDs across hydration', () => {
    const raw: ChatHistoryResponse = {
      sessionId: 'session-a',
      history: [
        {
          id: 2,
          role: 'assistant',
          content: 'Answer',
          activityTrace: { steps: [{ kind: 'thinking', text: 'Working' }] },
        },
      ],
    };
    const first = buildChatHistoryUiData(raw, 'session-a');
    expect(
      buildChatHistoryUiData(raw, 'session-a').messages.map(
        (message) => message.id,
      ),
    ).toEqual(first.messages.map((message) => message.id));
    expect(first.messages.map((message) => message.messageId)).toEqual([2, 2]);
  });
});
