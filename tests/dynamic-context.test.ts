import { expect, test } from 'vitest';

import {
  DYNAMIC_CONTEXT_MESSAGE_PREFIX,
  isDynamicContextMessageText,
} from '../container/shared/dynamic-context.js';
import { buildDynamicContextMessage } from '../src/agent/conversation.js';
import { readDynamicContextMessage } from '../src/gateway/gateway-service.js';

test('dynamic context builder and detectors share one stable contract', () => {
  const message = buildDynamicContextMessage(
    new Date('2026-07-20T12:00:00.000Z'),
  );

  expect(message.content).toEqual(
    expect.stringContaining(`${DYNAMIC_CONTEXT_MESSAGE_PREFIX}2026-07-20`),
  );
  expect(isDynamicContextMessageText(message.content)).toBe(true);
});

test('does not identify generic context-tagged user text as generated context', () => {
  expect(isDynamicContextMessageText('<context>user-provided text</context>'))
    .toBe(false);
  expect(
    isDynamicContextMessageText(
      '<context>\nDate (UTC): 2026-07-20\nmissing closing tag',
    ),
  ).toBe(false);
});

test('gateway logging ignores generic context-tagged user messages', () => {
  const generated = '<context>\nDate (UTC): 2026-07-20\n</context>';

  expect(
    readDynamicContextMessage([
      { role: 'user', content: '<context>pasted XML-like text</context>' },
      { role: 'assistant', content: 'response' },
      { role: 'user', content: generated },
    ]),
  ).toBe(generated);
});

test('session context renders in the dynamic message, after the header block', async () => {
  const { buildSessionContext } = await import(
    '../src/session/session-context.js'
  );
  const sessionContext = buildSessionContext({
    source: {
      channelKind: 'discord',
      chatId: '1475079601968648386',
      chatType: 'channel',
      userId: '123456',
      userName: 'alice',
    },
    agentId: 'main',
    sessionId: 'sess_20260316_185427_1a2b3c4d',
    sessionKey:
      'agent:main:channel:discord:chat:channel:peer:1475079601968648386',
  });
  const content = String(
    buildDynamicContextMessage({
      now: new Date('2026-07-20T12:00:00.000Z'),
      sessionSummary: 'Earlier context',
      sessionContext,
    }).content,
  );

  expect(content).toContain('## Session Context');
  expect(content).toContain('**Session:** sess_20260316_185427_1a2b3c4d');
  expect(content).toContain('**User:** alice (id: 123456)');
  expect(content.indexOf('</context>')).toBeLessThan(
    content.indexOf('## Session Context'),
  );
  expect(content.indexOf('## Session Context')).toBeLessThan(
    content.indexOf('## Session Summary'),
  );
  expect(
    String(
      buildDynamicContextMessage({ now: new Date(), sessionContext: null })
        .content,
    ),
  ).not.toContain('## Session Context');
});

test('history window note renders only when turns were omitted', async () => {
  const { buildHistoryWindowPrompt } = await import(
    '../src/agent/conversation.js'
  );

  expect(buildHistoryWindowPrompt(null)).toBe('');
  expect(
    buildHistoryWindowPrompt({
      droppedTurns: 0,
      droppedMessages: 0,
      historyTruncated: false,
    }),
  ).toBe('');

  const dropped = buildHistoryWindowPrompt({
    droppedTurns: 3,
    droppedMessages: 7,
    historyTruncated: false,
  });
  expect(dropped).toContain('## History Window');
  expect(dropped).toContain('The oldest 3 turn(s) (7 messages)');
  expect(dropped).toContain('not summarized');
  expect(dropped).not.toContain('beyond the loaded history window');

  const truncated = buildHistoryWindowPrompt({
    droppedTurns: 0,
    droppedMessages: 0,
    historyTruncated: true,
  });
  expect(truncated).toContain('## History Window');
  expect(truncated).toContain('beyond the loaded history window');

  const content = String(
    buildDynamicContextMessage({
      now: new Date('2026-07-20T12:00:00.000Z'),
      sessionSummary: 'Earlier context',
      historyWindow: {
        droppedTurns: 2,
        droppedMessages: 4,
        historyTruncated: false,
      },
    }).content,
  );
  expect(content.indexOf('## History Window')).toBeLessThan(
    content.indexOf('## Session Summary'),
  );
});
