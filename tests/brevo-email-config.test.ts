import { afterEach, expect, test, vi } from 'vitest';

import {
  normalizeAgentHandles,
  resolveBrevoConfig,
} from '../plugins/brevo-email/src/config.js';

const originalEnv = {
  BREVO_SMTP_LOGIN: process.env.BREVO_SMTP_LOGIN,
  BREVO_SMTP_KEY: process.env.BREVO_SMTP_KEY,
  BREVO_WEBHOOK_SECRET: process.env.BREVO_WEBHOOK_SECRET,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
});

test('resolveBrevoConfig rejects a missing webhook secret', () => {
  delete process.env.BREVO_SMTP_LOGIN;
  delete process.env.BREVO_SMTP_KEY;
  delete process.env.BREVO_WEBHOOK_SECRET;

  const api = {
    getCredential: vi.fn((key: string) => {
      if (key === 'BREVO_SMTP_LOGIN') return 'smtp-login';
      if (key === 'BREVO_SMTP_KEY') return 'smtp-key';
      return undefined;
    }),
  };

  expect(() => resolveBrevoConfig({}, api)).toThrow(
    'BREVO_WEBHOOK_SECRET is required but not set.',
  );
});

test('resolveBrevoConfig accepts a webhook secret from stored credentials', () => {
  delete process.env.BREVO_SMTP_LOGIN;
  delete process.env.BREVO_SMTP_KEY;
  delete process.env.BREVO_WEBHOOK_SECRET;

  const api = {
    getCredential: vi.fn((key: string) => {
      if (key === 'BREVO_SMTP_LOGIN') return 'smtp-login';
      if (key === 'BREVO_SMTP_KEY') return 'smtp-key';
      if (key === 'BREVO_WEBHOOK_SECRET') return 'brevo-webhook-secret';
      return undefined;
    }),
  };

  expect(resolveBrevoConfig({}, api)).toMatchObject({
    smtpLogin: 'smtp-login',
    smtpKey: 'smtp-key',
    webhookSecret: 'brevo-webhook-secret',
    smtpHost: 'smtp-relay.brevo.com',
    smtpPort: 587,
  });
});

test('normalizeAgentHandles lowercases entries and drops empty keys or values', () => {
  expect(
    normalizeAgentHandles({
      Writer: ' Steve-CF4 ',
      reviewer: '  ',
      '': 'ignored',
      main: ' Main-Handle ',
    }),
  ).toEqual({
    writer: 'steve-cf4',
    main: 'main-handle',
  });
});
