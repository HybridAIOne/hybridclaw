import { describe, expect, it } from 'vitest';
import type { ChatHistoryResponse } from '../../api/chat-types';
import { buildChatHistoryUiData } from './chat-history-query';

describe('buildChatHistoryUiData', () => {
  it('pairs assistant messages with the prior user content for replay', () => {
    const raw: ChatHistoryResponse = {
      sessionId: 'session-a',
      history: [
        { id: 1, role: 'user', content: 'first question' },
        { id: 2, role: 'assistant', content: 'first answer' },
        { id: 3, role: 'user', content: 'second question' },
        { id: 4, role: 'assistant', content: 'second answer' },
      ],
    };

    const ui = buildChatHistoryUiData(raw, 'session-a');

    const byRole = (role: string, content: string) =>
      ui.messages.find((m) => m.role === role && m.content === content);

    expect(byRole('user', 'first question')?.replayRequest?.content).toBe(
      'first question',
    );
    expect(byRole('assistant', 'first answer')?.replayRequest?.content).toBe(
      'first question',
    );
    expect(byRole('assistant', 'second answer')?.replayRequest?.content).toBe(
      'second question',
    );
    expect(byRole('user', 'first question')?.sessionId).toBe('session-a');
  });

  it('resolves branchKey only for messages whose id belongs to a variant in the current session', () => {
    const raw: ChatHistoryResponse = {
      sessionId: 'session-a',
      history: [
        { id: 10, role: 'assistant', content: 'variant A' },
        { id: 99, role: 'assistant', content: 'unrelated message' },
      ],
      branchFamilies: [
        {
          anchorSessionId: 'session-a',
          anchorMessageId: 10,
          variants: [
            { sessionId: 'session-a', messageId: 10 },
            { sessionId: 'session-b', messageId: 11 },
          ],
        },
      ],
    };

    const ui = buildChatHistoryUiData(raw, 'session-a');

    const anchored = ui.messages.find((m) => m.content === 'variant A');
    const unrelated = ui.messages.find(
      (m) => m.content === 'unrelated message',
    );
    expect(anchored?.branchKey).toBe('session-a:10');
    expect(unrelated?.branchKey).toBeNull();
    expect(ui.branchFamilies.get('session-a:10')).toEqual([
      { sessionId: 'session-a', messageId: 10 },
      { sessionId: 'session-b', messageId: 11 },
    ]);
  });

  it('falls back to the requested sessionId when the response omits it', () => {
    const raw: ChatHistoryResponse = {
      history: [{ id: 1, role: 'assistant', content: 'hi' }],
    };

    const ui = buildChatHistoryUiData(raw, 'session-fallback');

    expect(ui.resolvedSessionId).toBe('session-fallback');
    expect(ui.messages[0]?.sessionId).toBe('session-fallback');
  });

  it('preserves persisted artifacts from history messages', () => {
    const raw: ChatHistoryResponse = {
      sessionId: 'session-a',
      history: [
        {
          id: 1,
          role: 'assistant',
          content: 'Created haiku.pdf',
          artifacts: [
            {
              path: '/tmp/haiku.pdf',
              filename: 'haiku.pdf',
              mimeType: 'application/pdf',
            },
          ],
        },
      ],
    };

    const ui = buildChatHistoryUiData(raw, 'session-a');

    expect(ui.messages[0]?.artifacts).toEqual([
      {
        path: '/tmp/haiku.pdf',
        filename: 'haiku.pdf',
        mimeType: 'application/pdf',
      },
    ]);
  });

  it('returns resolvedSessionId from the response when present, even if it differs from the request', () => {
    const raw: ChatHistoryResponse = {
      sessionId: 'session-canonical',
      history: [{ id: 1, role: 'assistant', content: 'hi' }],
    };

    const ui = buildChatHistoryUiData(raw, 'session-requested');

    expect(ui.resolvedSessionId).toBe('session-canonical');
    expect(ui.messages[0]?.sessionId).toBe('session-canonical');
  });

  it('uses per-message assistantPresentation instead of session-level presentation', () => {
    const raw: ChatHistoryResponse = {
      sessionId: 'session-a',
      history: [
        { id: 1, role: 'user', content: 'hi' },
        { id: 2, role: 'assistant', content: 'hello' },
        {
          id: 3,
          role: 'assistant',
          content: 'charly hello',
          assistantPresentation: {
            agentId: 'charly',
            displayName: 'Charly',
            imageUrl: null,
          },
        },
      ],
      assistantPresentation: {
        agentId: 'charly',
        displayName: 'Charly',
        imageUrl: null,
      },
    };

    const ui = buildChatHistoryUiData(raw, 'session-a');

    const mainAssistant = ui.messages.find((m) => m.content === 'hello');
    const charlyAssistant = ui.messages.find(
      (m) => m.content === 'charly hello',
    );

    expect(mainAssistant?.assistantPresentation).toBeNull();
    expect(charlyAssistant?.assistantPresentation).toMatchObject({
      agentId: 'charly',
      displayName: 'Charly',
    });
  });
});
