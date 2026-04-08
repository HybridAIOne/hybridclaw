import { expect, test, vi } from 'vitest';

vi.mock('hybridclaw/plugin-sdk', () => ({}));

import { createSendEmailToolHandler } from '../plugins/brevo-email/src/index.js';

test('send_email validates recipient fields before calling SMTP', async () => {
  const send = vi.fn();
  const handler = createSendEmailToolHandler(
    {
      config: {
        agents: {
          defaultAgentId: 'main',
        },
      },
      resolveSessionAgentId: vi.fn(() => 'writer'),
    } as never,
    {
      domain: 'agent.hybridai.one',
      fromName: '',
      fromAddress: '',
      agentHandles: {
        writer: 'writer-handle',
      },
    } as never,
    send,
  );

  for (const [field, value] of [
    ['to', 'the user'],
    ['cc', 'also the user'],
    ['bcc', 'hidden recipient'],
  ]) {
    await expect(
      handler(
        {
          to: 'friend@example.com',
          subject: 'Hello',
          body: 'Test body',
          [field]: value,
        },
        {
          sessionId: 'session-1',
        },
      ),
    ).rejects.toThrow(
      `Invalid ${field} email address. Provide a plain email address like user@example.com.`,
    );
  }

  expect(send).not.toHaveBeenCalled();
});

test('send_email trims and forwards validated recipients', async () => {
  const send = vi.fn();
  const resolveSessionAgentId = vi.fn(() => 'writer');
  const handler = createSendEmailToolHandler(
    {
      config: {
        agents: {
          defaultAgentId: 'main',
        },
      },
      resolveSessionAgentId,
    } as never,
    {
      domain: 'agent.hybridai.one',
      fromName: 'Writer',
      fromAddress: '',
      agentHandles: {
        writer: 'writer-handle',
      },
    } as never,
    send,
  );

  await expect(
    handler(
      {
        to: '  friend@example.com  ',
        cc: '  copy@example.com  ',
        bcc: '  blind@example.com  ',
        subject: 'Hello',
        body: 'Test body',
      },
      {
        sessionId: 'session-1',
      },
    ),
  ).resolves.toEqual({
    sent: true,
    from: '"Writer" <writer-handle@agent.hybridai.one>',
    to: 'friend@example.com',
    subject: 'Hello',
  });

  expect(resolveSessionAgentId).toHaveBeenCalledWith('session-1');
  expect(send).toHaveBeenCalledWith({
    from: '"Writer" <writer-handle@agent.hybridai.one>',
    to: 'friend@example.com',
    cc: 'copy@example.com',
    bcc: 'blind@example.com',
    subject: 'Hello',
    body: 'Test body',
  });
});

test('send_email forwards optional threading headers', async () => {
  const send = vi.fn();
  const handler = createSendEmailToolHandler(
    {
      config: {
        agents: {
          defaultAgentId: 'main',
        },
      },
      resolveSessionAgentId: vi.fn(() => 'writer'),
    } as never,
    {
      domain: 'agent.hybridai.one',
      fromName: '',
      fromAddress: '',
      agentHandles: {
        writer: 'writer-handle',
      },
    } as never,
    send,
  );

  await expect(
    handler(
      {
        to: 'friend@example.com',
        subject: 'Re: Hello',
        body: 'Follow-up',
        inReplyTo: '  <msg-1@example.com>  ',
        references: ['  <msg-0@example.com>  ', '<msg-1@example.com>'],
      },
      {
        sessionId: 'session-1',
      },
    ),
  ).resolves.toEqual({
    sent: true,
    from: 'writer-handle@agent.hybridai.one',
    to: 'friend@example.com',
    subject: 'Re: Hello',
  });

  expect(send).toHaveBeenCalledWith({
    from: 'writer-handle@agent.hybridai.one',
    to: 'friend@example.com',
    subject: 'Re: Hello',
    body: 'Follow-up',
    inReplyTo: '<msg-1@example.com>',
    references: ['<msg-0@example.com>', '<msg-1@example.com>'],
  });
});

test('send_email validates threading header argument types', async () => {
  const send = vi.fn();
  const handler = createSendEmailToolHandler(
    {
      config: {
        agents: {
          defaultAgentId: 'main',
        },
      },
      resolveSessionAgentId: vi.fn(() => 'writer'),
    } as never,
    {
      domain: 'agent.hybridai.one',
      fromName: '',
      fromAddress: '',
      agentHandles: {
        writer: 'writer-handle',
      },
    } as never,
    send,
  );

  await expect(
    handler(
      {
        to: 'friend@example.com',
        subject: 'Hello',
        body: 'Test body',
        inReplyTo: ['<msg-1@example.com>'],
      },
      {
        sessionId: 'session-1',
      },
    ),
  ).rejects.toThrow('inReplyTo must be a string.');

  await expect(
    handler(
      {
        to: 'friend@example.com',
        subject: 'Hello',
        body: 'Test body',
        references: '<msg-1@example.com>',
      },
      {
        sessionId: 'session-1',
      },
    ),
  ).rejects.toThrow('references must be an array of strings.');

  await expect(
    handler(
      {
        to: 'friend@example.com',
        subject: 'Hello',
        body: 'Test body',
        references: ['<msg-1@example.com>', 2],
      },
      {
        sessionId: 'session-1',
      },
    ),
  ).rejects.toThrow('references entries must be strings.');

  expect(send).not.toHaveBeenCalled();
});
