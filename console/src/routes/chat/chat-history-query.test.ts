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

  it('preserves routed user content on reloaded user bubbles', () => {
    const raw: ChatHistoryResponse = {
      sessionId: 'session-a',
      agentId: 'main',
      history: [
        { id: 1, role: 'user', content: 'summarize this' },
        {
          id: 2,
          role: 'assistant',
          agent_id: 'research',
          content: 'summary',
          assistantPresentation: {
            agentId: 'research',
            displayName: 'Research Agent',
            imageUrl: '/api/agent-avatar?agentId=research',
          },
        },
      ],
    };

    const ui = buildChatHistoryUiData(raw, 'session-a');
    const user = ui.messages.find((message) => message.role === 'user');
    const assistant = ui.messages.find(
      (message) => message.role === 'assistant',
    );

    expect(user?.content).toBe('summarize this');
    expect(user?.rawContent).toBe('summarize this');
    expect(user?.addressedAgentPresentation).toMatchObject({
      agentId: 'research',
      displayName: 'Research Agent',
      imageUrl: '/api/agent-avatar?agentId=research',
    });
    expect(user?.replayRequest?.content).toBe('summarize this');
    expect(assistant?.replayRequest?.content).toBe('summarize this');
  });

  it('does not add attribution when history omits the session agent id', () => {
    const raw: ChatHistoryResponse = {
      sessionId: 'session-a',
      history: [
        {
          id: 1,
          role: 'user',
          content:
            "I'm Ben. I'm coding HybridClaw. I use Claude Code. Help me with organizing my daily work.",
        },
        {
          id: 2,
          role: 'assistant',
          agent_id: 'test2',
          content: 'Nice to meet you, Ben.',
          assistantPresentation: {
            agentId: 'test2',
            displayName: 'test2',
            imageUrl: '/api/agent-avatar?agentId=test2',
          },
        },
      ],
    };

    const ui = buildChatHistoryUiData(raw, 'session-a');
    const user = ui.messages.find((message) => message.role === 'user');

    expect(user?.content).toBe(
      "I'm Ben. I'm coding HybridClaw. I use Claude Code. Help me with organizing my daily work.",
    );
    expect(user?.rawContent).toBe(
      "I'm Ben. I'm coding HybridClaw. I use Claude Code. Help me with organizing my daily work.",
    );
  });

  it('does not add attribution for the active session agent on reload', () => {
    const raw: ChatHistoryResponse = {
      sessionId: 'session-a',
      agentId: 'test1',
      history: [
        { id: 1, role: 'user', content: 'Hi' },
        { id: 2, role: 'assistant', agent_id: 'test1', content: 'Hello' },
      ],
    };

    const ui = buildChatHistoryUiData(raw, 'session-a');
    const user = ui.messages.find((message) => message.role === 'user');

    expect(user?.content).toBe('Hi');
    expect(user?.rawContent).toBe('Hi');
    expect(user?.addressedAgentPresentation).toBeNull();
  });

  it('preserves an explicit leading agent mention on reload', () => {
    const raw: ChatHistoryResponse = {
      sessionId: 'session-a',
      agentId: 'main',
      history: [
        { id: 1, role: 'user', content: '@Charly Hi!' },
        {
          id: 2,
          role: 'assistant',
          agent_id: 'charly',
          content: 'Hi back',
          assistantPresentation: {
            agentId: 'charly',
            displayName: 'Charly',
            imageUrl: null,
          },
        },
      ],
    };

    const ui = buildChatHistoryUiData(raw, 'session-a');
    const user = ui.messages.find((message) => message.role === 'user');

    expect(user?.content).toBe('@Charly Hi!');
    expect(user?.rawContent).toBe('@Charly Hi!');
    expect(user?.addressedAgentPresentation).toMatchObject({
      agentId: 'charly',
      displayName: 'Charly',
    });
  });

  it('does not add main-agent attribution on reload', () => {
    const raw: ChatHistoryResponse = {
      sessionId: 'session-a',
      history: [
        { id: 1, role: 'user', content: 'hello' },
        { id: 2, role: 'assistant', agent_id: 'main', content: 'hi' },
      ],
    };

    const ui = buildChatHistoryUiData(raw, 'session-a');

    expect(
      ui.messages.find((message) => message.role === 'user')?.content,
    ).toBe('hello');
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

  it('preserves the active session agent id for the composer selector', () => {
    const raw: ChatHistoryResponse = {
      sessionId: 'session-a',
      agentId: 'research',
      history: [{ id: 1, role: 'assistant', content: 'hi' }],
    };

    const ui = buildChatHistoryUiData(raw, 'session-a');

    expect(ui.agentId).toBe('research');
  });

  it('preserves bootstrap autostart status for the chat page', () => {
    const raw: ChatHistoryResponse = {
      sessionId: 'session-a',
      history: [{ id: 1, role: 'assistant', content: 'hi' }],
      bootstrapAutostart: {
        status: 'starting',
        fileName: 'BOOTSTRAP.md',
      },
    };

    const ui = buildChatHistoryUiData(raw, 'session-a');

    expect(ui.bootstrapAutostart).toEqual({
      status: 'starting',
      fileName: 'BOOTSTRAP.md',
    });
  });

  it('hydrates a collapsed trace immediately before its assistant message', () => {
    const raw: ChatHistoryResponse = {
      sessionId: 'session-a',
      history: [
        { id: 1, role: 'user', content: 'Read my email' },
        {
          id: 2,
          role: 'assistant',
          content: 'Here are your emails.',
          activityTrace: {
            steps: [
              { kind: 'thinking', text: 'Listing their messages' },
              { kind: 'draft', text: 'I will check the inbox first.' },
              {
                kind: 'tool',
                toolName: 'list_messages',
                status: 'done',
                argsPreview: '{"top":20}',
                durationMs: 903,
              },
            ],
            elapsedMs: 34_000,
          },
        },
      ],
    };

    const ui = buildChatHistoryUiData(raw, 'session-a');

    const assistantIndex = ui.messages.findIndex((m) => m.role === 'assistant');
    const trace = ui.messages[assistantIndex - 1];
    expect(trace?.role).toBe('trace');
    if (trace?.role !== 'trace') throw new Error('expected a trace message');
    expect(trace.done).toBe(true);
    expect(trace.finishedAt).toBe(34_000);
    expect(trace.steps).toEqual([
      { kind: 'thinking', text: 'Listing their messages' },
      { kind: 'draft', text: 'I will check the inbox first.' },
      {
        kind: 'tool',
        toolName: 'list_messages',
        status: 'done',
        argsPreview: '{"top":20}',
        durationMs: 903,
      },
    ]);
  });

  it('does not add a trace message when history omits activityTrace', () => {
    const raw: ChatHistoryResponse = {
      sessionId: 'session-a',
      history: [
        { id: 1, role: 'user', content: 'hi' },
        { id: 2, role: 'assistant', content: 'hello' },
        {
          id: 3,
          role: 'assistant',
          content: 'empty trace',
          activityTrace: { steps: [] },
        },
      ],
    };

    const ui = buildChatHistoryUiData(raw, 'session-a');

    expect(ui.messages.some((m) => m.role === 'trace')).toBe(false);
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
