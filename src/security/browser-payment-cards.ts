/**
 * Payment card details the user typed into their client's card sheet for the
 * agent's browser (`browser_fill_payment`). They are held in gateway memory
 * for ten minutes, never written to disk, and only resolve into a page on the
 * host they were given for (`/api/secret/inject`), so the model never sees
 * them. A gateway restart forgets them; the agent then asks again.
 *
 * Each save gets fresh secret names, so a name the agent saw for an earlier
 * card never reaches a later one.
 */
import { randomBytes } from 'node:crypto';

import { normalizeBrowserSignInHost } from './browser-sign-ins.js';
import { luhnCheck } from './redact.js';

export const PAYMENT_CARD_SECRET_PREFIX = 'PAYCARD_';
export const PAYMENT_CARD_TTL_MS = 10 * 60_000;

export const PAYMENT_CARD_FIELDS = [
  'number',
  'expiry',
  'expiry_month',
  'expiry_year',
  'expiry_year_short',
  'cvc',
] as const;
export type PaymentCardField = (typeof PAYMENT_CARD_FIELDS)[number];

interface HeldCard {
  host: string;
  secrets: Record<PaymentCardField, string>;
  expiresAt: number;
}

// By host; the latest card the user entered for a site replaces the one before.
const cardsByHost = new Map<string, HeldCard>();
// By secret name: the value and the card it belongs to.
const valuesByName = new Map<string, { card: HeldCard; value: string }>();

export interface BrowserPaymentCard {
  host: string;
  /** The store-style name of each field, never a value. */
  secrets: Record<PaymentCardField, string>;
}

export function isPaymentCardSecretName(name: string): boolean {
  return name.startsWith(PAYMENT_CARD_SECRET_PREFIX);
}

function forget(card: HeldCard): void {
  for (const name of Object.values(card.secrets)) valuesByName.delete(name);
  if (cardsByHost.get(card.host) === card) cardsByHost.delete(card.host);
}

function liveCard(host: string, now: number): HeldCard | null {
  const card = cardsByHost.get(host);
  if (!card) return null;
  if (card.expiresAt > now) return card;
  forget(card);
  return null;
}

function parseExpiry(
  raw: unknown,
  now: Date,
): { month: string; year: string } | null {
  const match = String(raw ?? '')
    .trim()
    .match(/^(\d{1,2})\s*[/.-]?\s*(\d{2}|\d{4})$/);
  if (!match) return null;
  const month = Number(match[1]);
  const year =
    match[2].length === 2 ? 2000 + Number(match[2]) : Number(match[2]);
  if (month < 1 || month > 12) return null;
  // A card is good through the last day of its month.
  const lastMonth = now.getUTCFullYear() * 12 + now.getUTCMonth();
  if (year * 12 + month - 1 < lastMonth) return null;
  return { month: String(month).padStart(2, '0'), year: String(year) };
}

/**
 * Hold a card for a site. Throws on a bad host or card; the message never
 * contains a value.
 */
export function saveBrowserPaymentCard(
  params: { host: unknown; number: unknown; expiry: unknown; cvc: unknown },
  now = Date.now(),
): { host: string; expiresAt: number } {
  const host = normalizeBrowserSignInHost(params.host);
  if (!host) throw new Error('Expected the site as a hostname.');
  const number = String(params.number ?? '').replace(/[\s-]/g, '');
  if (!/^\d{12,19}$/.test(number) || !luhnCheck(number)) {
    throw new Error('The card number is not valid.');
  }
  const expiry = parseExpiry(params.expiry, new Date(now));
  if (!expiry) throw new Error('The expiry date is not valid.');
  const cvc = String(params.cvc ?? '').trim();
  if (!/^\d{3,4}$/.test(cvc))
    throw new Error('The security code is not valid.');

  const previous = cardsByHost.get(host);
  if (previous) forget(previous);
  const id = randomBytes(6).toString('hex').toUpperCase();
  const values: Record<PaymentCardField, string> = {
    number,
    expiry: `${expiry.month}/${expiry.year.slice(2)}`,
    expiry_month: expiry.month,
    expiry_year: expiry.year,
    expiry_year_short: expiry.year.slice(2),
    cvc,
  };
  const card: HeldCard = {
    host,
    secrets: Object.fromEntries(
      PAYMENT_CARD_FIELDS.map((field) => [
        field,
        `${PAYMENT_CARD_SECRET_PREFIX}${id}_${field.toUpperCase()}`,
      ]),
    ) as Record<PaymentCardField, string>,
    expiresAt: now + PAYMENT_CARD_TTL_MS,
  };
  cardsByHost.set(host, card);
  for (const field of PAYMENT_CARD_FIELDS) {
    valuesByName.set(card.secrets[field], { card, value: values[field] });
  }
  return { host, expiresAt: card.expiresAt };
}

/** The names of the card held for exactly this host, if there is one. */
export function findBrowserPaymentCard(
  rawHost: unknown,
  now = Date.now(),
): BrowserPaymentCard | null {
  const host = normalizeBrowserSignInHost(rawHost);
  const card = host ? liveCard(host, now) : null;
  return card ? { host, secrets: { ...card.secrets } } : null;
}

/**
 * The value behind a card field's name, for typing into a page on `host`.
 * Throws when the card is gone or the page is on another site.
 */
export function resolveBrowserPaymentCardSecret(
  name: string,
  rawHost: unknown,
  now = Date.now(),
): string {
  const entry = valuesByName.get(name);
  if (!entry || !liveCard(entry.card.host, now)) {
    throw new Error(
      'The card details are no longer held. Call browser_fill_payment again to ask the user.',
    );
  }
  const host = normalizeBrowserSignInHost(rawHost);
  if (host !== entry.card.host) {
    throw new Error(
      `The card details are only for ${entry.card.host}, not ${host || 'a request without a site'}.`,
    );
  }
  return entry.value;
}

/** For tests: drop every held card. */
export function clearBrowserPaymentCards(): void {
  cardsByHost.clear();
  valuesByName.clear();
}
