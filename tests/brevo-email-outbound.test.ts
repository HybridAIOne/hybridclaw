import { expect, test, vi } from 'vitest';
import { createBrevoSmtpService } from '../plugins/brevo-email/src/brevo-outbound.js';

test('createBrevoSmtpService fails startup when SMTP verification fails', async () => {
  const verifyError = new Error('invalid login');
  const closeMock = vi.fn();
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const createTransportMock = vi.fn(() => ({
    verify: vi.fn().mockRejectedValue(verifyError),
    sendMail: vi.fn(),
    close: closeMock,
  }));

  const { service } = createBrevoSmtpService(
    {
      smtpHost: 'smtp-relay.brevo.com',
      smtpPort: 587,
      smtpLogin: 'smtp-login',
      smtpKey: 'smtp-key',
    },
    logger as never,
    createTransportMock as never,
  );

  await expect(service.start?.()).rejects.toBe(verifyError);
  expect(createTransportMock).toHaveBeenCalledTimes(1);
  expect(logger.error).toHaveBeenCalledWith(
    expect.objectContaining({
      error: verifyError,
      host: 'smtp-relay.brevo.com',
      port: 587,
    }),
    'Brevo SMTP verification failed',
  );
  expect(closeMock).toHaveBeenCalledTimes(1);
});

test('createBrevoSmtpService forwards optional threading headers', async () => {
  const sendMailMock = vi.fn();
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const createTransportMock = vi.fn(() => ({
    verify: vi.fn(),
    sendMail: sendMailMock,
    close: vi.fn(),
  }));

  const { send } = createBrevoSmtpService(
    {
      smtpHost: 'smtp-relay.brevo.com',
      smtpPort: 587,
      smtpLogin: 'smtp-login',
      smtpKey: 'smtp-key',
    },
    logger as never,
    createTransportMock as never,
  );

  await send({
    from: 'writer@example.com',
    to: 'friend@example.com',
    subject: 'Re: Hello',
    body: 'Follow-up',
    inReplyTo: '<msg-1@example.com>',
    references: ['<msg-0@example.com>', '<msg-1@example.com>'],
  });

  expect(sendMailMock).toHaveBeenCalledWith({
    from: 'writer@example.com',
    to: 'friend@example.com',
    subject: 'Re: Hello',
    text: 'Follow-up',
    inReplyTo: '<msg-1@example.com>',
    references: ['<msg-0@example.com>', '<msg-1@example.com>'],
  });
});

test('createBrevoSmtpService normalizes explicit threading headers', async () => {
  const sendMailMock = vi.fn();
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const createTransportMock = vi.fn(() => ({
    verify: vi.fn(),
    sendMail: sendMailMock,
    close: vi.fn(),
  }));

  const { send } = createBrevoSmtpService(
    {
      smtpHost: 'smtp-relay.brevo.com',
      smtpPort: 587,
      smtpLogin: 'smtp-login',
      smtpKey: 'smtp-key',
    },
    logger as never,
    createTransportMock as never,
  );

  await send({
    from: 'writer@example.com',
    to: 'friend@example.com',
    subject: 'Re: Hello',
    body: 'Follow-up',
    inReplyTo: '<root@example.com>',
    references: ['<root@example.com>', '<latest@example.com>'],
  });

  expect(sendMailMock).toHaveBeenCalledWith({
    from: 'writer@example.com',
    to: 'friend@example.com',
    subject: 'Re: Hello',
    text: 'Follow-up',
    inReplyTo: '<latest@example.com>',
    references: ['<root@example.com>', '<latest@example.com>'],
  });
});
