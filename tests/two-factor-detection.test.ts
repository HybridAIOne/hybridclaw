import { expect, test } from 'vitest';

import { detectTwoFactorChallenge } from '../container/shared/two-factor-detection.js';

const TEL = 'input[type="tel"]';
const NUMERIC = 'input[inputmode="numeric"]';
const CODE_NAME = 'input[name*="code" i]';
const ONE_TIME_CODE = 'input[autocomplete="one-time-code"]';
const OTP_NAME = 'input[name*="otp" i]';

// A long marketing page: two-factor sign-in is a feature here, not a challenge.
const HOME_PAGE = [
  'Build and ship software on a single, collaborative platform.',
  'Push code, review pull requests and get push notifications when a deploy is done.',
  'Every account can turn on two-factor authentication.',
  'Scan the QR code to get the mobile app. Get SMS alerts for outages.',
]
  .join('\n')
  .repeat(12);

test.each([
  {
    page: 'authenticator code',
    title: 'Two-factor authentication',
    text: 'Authentication code\nOpen your two-factor authenticator (TOTP) app to view your authentication code.\nVerify',
    selectors: [ONE_TIME_CODE, NUMERIC],
    modality: 'totp',
  },
  {
    page: 'push approval without a field',
    title: 'Sign in',
    text: "2-Step Verification\nTo help keep your account safe, we want to make sure it's really you.\nCheck your phone\nWe sent a notification to your Pixel 8. Tap Yes on the notification to continue.\nTry another way",
    selectors: [],
    modality: 'push',
  },
  {
    page: 'number match',
    title: 'Sign in to your account',
    text: 'Approve sign in request\nOpen your Authenticator app, and enter the number shown to sign in.\n42',
    selectors: [],
    modality: 'push',
  },
  {
    page: 'SMS code in a phone field',
    title: 'Verify it is you',
    text: 'Enter verification code\nWe sent a 6-digit code to +49 ••• ••• 89.\nResend code',
    selectors: [TEL, CODE_NAME],
    modality: 'sms',
  },
  {
    page: 'German SMS code',
    title: 'Anmeldung bestätigen',
    text: 'Bestätigungscode eingeben\nWir haben Ihnen per SMS einen Code geschickt.',
    selectors: [NUMERIC],
    modality: 'sms',
  },
  {
    page: 'OTP field on a long page',
    title: 'Your account',
    text: 'Orders\nAddresses\nSecurity\n'.repeat(120),
    selectors: [OTP_NAME, TEL],
    modality: 'totp',
  },
])('parks a real second-factor page: $page', (page) => {
  const result = detectTwoFactorChallenge(page);
  expect(result.detected).toBe(true);
  expect(result.modality).toBe(page.modality);
});

test.each([
  {
    page: 'order form with a phone field',
    title: '',
    text: 'Customer name:\nTelephone:\nE-mail address:\nPizza Size\nSmall\nMedium\nLarge\nPreferred delivery time:\nSubmit order',
    selectors: [TEL],
  },
  {
    page: 'home page that mentions push, SMS, QR and two-factor',
    title: 'Home',
    text: HOME_PAGE,
    selectors: [],
  },
  {
    page: 'short page that mentions push',
    title: 'Cheap flights',
    text: 'Find cheap flights\nFrom\nTo\nSearch\nTurn on push notifications for price drops.',
    selectors: [],
  },
  {
    page: 'delivery address with postcode, phone and SMS updates',
    title: 'Lieferadresse',
    text: 'Vorname\nNachname\nStraße\nPostleitzahl\nStadt\nTelefonnummer für Updates per SMS\nWeiter zur Zahlung',
    selectors: [TEL, NUMERIC, CODE_NAME],
  },
  {
    page: 'card payment',
    title: 'Payment',
    text: 'Card number\nExpiry date\nCard verification code (CVC)\nPay now',
    selectors: [NUMERIC, CODE_NAME],
  },
])('does not park $page', (page) => {
  expect(detectTwoFactorChallenge(page)).toMatchObject({
    detected: false,
    modality: null,
    signals: [],
  });
});
