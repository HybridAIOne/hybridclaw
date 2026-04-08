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
