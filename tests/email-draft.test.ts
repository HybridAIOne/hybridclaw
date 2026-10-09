import { expect, test, vi } from 'vitest';

import { normalizeEmailDraft } from '../container/shared/email-draft.js';
import { runDraftEmailTool } from '../container/src/tools/draft-email.js';
import {
  replyWithEmailDraft,
  turnEmailDraft,
} from '../src/gateway/email-draft.js';
import { chatResultForClient } from '../src/gateway/mobile-chat-result.js';
import type { ContainerOutput } from '../src/types/container.js';
import type { ToolExecution } from '../src/types/execution.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));
vi.mock('../src/agent/agent.js', () => ({ runAgent: runAgentMock }));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-email-draft-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

const draft = {
  from: 'me@example.com',
  to: ['franziska@example.com'],
  subject: 'Re: PNG export',
  body: 'Hi Franziska,\n\ncould you send the affected report?\n\nLiebe Grüße\nBenedikt',
  source: 'Gmail, me@example.com, thread 42',
};

function call(args: unknown, extra: Partial<ToolExecution> = {}): ToolExecution {
  return {
    name: 'draft_email',
    arguments: JSON.stringify(args),
    result: 'ok',
    durationMs: 1,
    ...extra,
  };
}

test('the tool accepts a complete draft and refuses one it cannot show', () => {
  expect(normalizeEmailDraft({ ...draft, cc: [], subject: '  ' })).toEqual({
    draft: {
      from: draft.from,
      to: draft.to,
      body: draft.body,
      source: draft.source,
    },
  });
  expect(runDraftEmailTool(draft).ok).toBe(true);
  for (const args of [
    {},
    { body: '   ' },
    { body: 'Hi', to: 'franziska@example.com' },
    { body: 'Hi', to: ['Franziska <franziska@example.com>'] },
    { body: 'Hi', subject: 'Demo\nBcc: wrong@example.com' },
  ]) {
    expect(runDraftEmailTool(args).ok).toBe(false);
  }
});

test('a turn shows its last successful draft, never a refused or blocked one', () => {
  expect(
    turnEmailDraft([
      call({ ...draft, body: 'First' }),
      call(draft),
      call({ ...draft, body: 'Refused' }, { isError: true }),
      call({ ...draft, body: 'Blocked' }, { blocked: true }),
      { name: 'read', arguments: '{}', result: '', durationMs: 1 },
    ])?.body,
  ).toBe(draft.body);
  expect(turnEmailDraft([call({ body: '' })])).toBeNull();
  expect(turnEmailDraft(undefined)).toBeNull();
});

test('the stored reply carries the draft as fenced text, the card keeps the reply', () => {
  const shown = replyWithEmailDraft('I drafted a reply.', {
    body: 'See ```code``` here',
  });
  expect(shown.content).toBe(
    'I drafted a reply.\n\n**Email draft (not sent)**\n````text\nSee ```code``` here\n````',
  );
  expect(shown.emailDraft).toEqual({
    body: 'See ```code``` here',
    reply: 'I drafted a reply.',
  });
  expect(
    replyWithEmailDraft('', draft, { proactive: true }).emailDraft,
  ).toMatchObject({ reply: '', proactive: true });
  expect(replyWithEmailDraft('Hello', null)).toEqual({ content: 'Hello' });
});

test('a phone turn returns the draft and history keeps it after reload', async () => {
  setupHome();
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true });
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.js'
  );
  const { getGatewayHistory } = await import(
    '../src/gateway/gateway-service.js'
  );
  runAgentMock.mockResolvedValueOnce({
    status: 'success',
    result: '',
    toolsUsed: ['draft_email'],
    toolExecutions: [call(draft)],
  } satisfies ContainerOutput);
  const result = await handleGatewayMessage({
    sessionId: 'web:phone',
    guildId: null,
    channelId: 'web',
    userId: 'user_a',
    username: 'web',
    model: 'hybridai/gpt-5-mini',
    chatbotId: 'bot_a',
    content: 'Draft a reply to Franziska',
    client: 'mobile',
  });
  expect(result.emailDraft).toEqual({ ...draft, reply: '' });
  expect(result.result).toContain('Hi Franziska,');
  expect(chatResultForClient('mobile', result).emailDraft).toEqual(
    result.emailDraft,
  );
  const stored = getGatewayHistory('web:phone').history.at(-1);
  expect(stored?.emailDraft).toEqual({ ...draft, reply: '' });
  expect(stored?.content).toBe(result.result);
});

test('a reply a check stored hands its draft to the phone', async () => {
  setupHome();
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true });
  db.getOrCreateSession('web:check', null, 'web');
  const id = db.storeMessage('web:check', 'assistant', null, 'assistant', 'x');
  db.setMessageEmailDraft(id, { ...draft, reply: 'Franziska wrote.', proactive: true });
  expect(db.getSessionAssistantMessage('web:check', id)?.emailDraft).toEqual({
    ...draft,
    reply: 'Franziska wrote.',
    proactive: true,
  });
});
