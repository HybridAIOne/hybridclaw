import { afterEach, describe, expect, test } from 'vitest';

import {
  clearBrowserPaymentCards,
  findBrowserPaymentCard,
  PAYMENT_CARD_TTL_MS,
  resolveBrowserPaymentCardSecret,
  saveBrowserPaymentCard,
} from '../src/security/browser-payment-cards.js';

const NOW = Date.UTC(2026, 10, 22);
const CARD = {
  host: 'Shop.example.',
  number: '4242 4242 4242 4242',
  expiry: '4/2028',
  cvc: '123',
};

describe('payment cards for the browser', () => {
  afterEach(() => clearBrowserPaymentCards());

  test('holds a card for its exact host and gives out names, not values', () => {
    saveBrowserPaymentCard(CARD, NOW);
    const card = findBrowserPaymentCard('shop.example', NOW);

    expect(card?.host).toBe('shop.example');
    expect(JSON.stringify(card)).not.toContain('4242');
    const secrets = card?.secrets ?? ({} as Record<string, string>);
    expect(resolveBrowserPaymentCardSecret(secrets.number, 'shop.example', NOW)).toBe('4242424242424242');
    expect(resolveBrowserPaymentCardSecret(secrets.expiry, 'shop.example', NOW)).toBe('04/28');
    expect(resolveBrowserPaymentCardSecret(secrets.expiry_year, 'shop.example', NOW)).toBe('2028');
    // Neither a subdomain nor another site gets it.
    expect(findBrowserPaymentCard('pay.shop.example', NOW)).toBeNull();
    expect(() =>
      resolveBrowserPaymentCardSecret(secrets.cvc, 'evil.example', NOW),
    ).toThrow('only for shop.example');
  });

  test('forgets a card after ten minutes and when a new one replaces it', () => {
    saveBrowserPaymentCard(CARD, NOW);
    const first = findBrowserPaymentCard('shop.example', NOW)?.secrets.number ?? '';
    saveBrowserPaymentCard({ ...CARD, cvc: '456' }, NOW);

    expect(() =>
      resolveBrowserPaymentCardSecret(first, 'shop.example', NOW),
    ).toThrow('no longer held');
    expect(
      findBrowserPaymentCard('shop.example', NOW + PAYMENT_CARD_TTL_MS),
    ).toBeNull();
  });

  test('refuses card details that cannot be right, without echoing them', () => {
    for (const [change, message] of [
      [{ number: '4242 4242 4242 4241' }, 'card number'],
      [{ expiry: '13/30' }, 'expiry'],
      [{ expiry: '10/26' }, 'expiry'],
      [{ cvc: '12' }, 'security code'],
    ] as const) {
      expect(() => saveBrowserPaymentCard({ ...CARD, ...change }, NOW)).toThrow(
        message,
      );
    }
    // A card is good through the end of its month.
    expect(() =>
      saveBrowserPaymentCard({ ...CARD, expiry: '11/26' }, NOW),
    ).not.toThrow();
  });
});
