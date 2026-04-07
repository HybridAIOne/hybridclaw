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
