import { expect, test, vi } from 'vitest';

import { normalizeEmailDraft } from '../container/shared/email-draft.js';
import {
  DRAFT_EMAIL_TOOL_DEFINITION,
  runDraftEmailTool,
} from '../container/src/tools/draft-email.js';
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
  expect(normalizeEmailDraft({ ...draft, cc: [], bcc: null })).toEqual({
    draft,
  });
  expect(runDraftEmailTool(draft).ok).toBe(true);
  for (const args of [
    {},
    { ...draft, body: '   ' },
    { ...draft, to: 'franziska@example.com' },
    { ...draft, to: ['Franziska <franziska@example.com>'] },
    { ...draft, subject: 'Demo\nBcc: wrong@example.com' },
  ]) {
    expect(runDraftEmailTool(args).ok).toBe(false);
  }
});

test('every draft needs from, to and subject, and the refusal says how to fix it', () => {
  expect(DRAFT_EMAIL_TOOL_DEFINITION.function.parameters.required).toEqual([
    'from',
    'to',
    'subject',
    'body',
  ]);
  const newEmail = {
    from: 'pat@example.com',
    to: ['pat@example.com'],
    subject: 'Friday',
    body: 'See you then.',
  };
  expect(normalizeEmailDraft(newEmail)).toEqual({ draft: newEmail });
  const { from: _from, ...withoutFrom } = newEmail;
  for (const args of [withoutFrom, { ...newEmail, from: '  ' }]) {
    const refused = runDraftEmailTool(args);
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain('"from" is required');
    expect(refused.text).toContain('Sent folder');
  }
  for (const from of ['Pat <pat@example.com>', 'pat', 'a@b@example.com']) {
    expect(normalizeEmailDraft({ ...newEmail, from }).error).toContain(
      '"from" must be one plain email address',
    );
  }
  for (const to of [undefined, []]) {
    expect(normalizeEmailDraft({ ...newEmail, to }).error).toContain(
      '"to" is required',
    );
  }
  expect(normalizeEmailDraft({ ...newEmail, subject: ' ' }).error).toContain(
    '"subject" is required',
  );
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
  expect(turnEmailDraft([call({ ...draft, from: undefined })])).toBeNull();
  expect(turnEmailDraft(undefined)).toBeNull();
});

test('the stored reply carries the draft as fenced text, the card keeps the reply', () => {
  const code = {
    from: 'pat@example.com',
    to: ['sam@example.com'],
    subject: 'Re: Friday',
    body: 'See ```code``` here',
  };
  const shown = replyWithEmailDraft('I drafted a reply.', code);
  expect(shown.content).toBe(
    'I drafted a reply.\n\n**Email draft (not sent)**\n````text\nFrom: pat@example.com\nTo: sam@example.com\nSubject: Re: Friday\n\nSee ```code``` here\n````',
  );
  expect(shown.emailDraft).toEqual({ ...code, reply: 'I drafted a reply.' });
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
