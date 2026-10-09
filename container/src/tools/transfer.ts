/**
 * `draft_transfer`: a bank transfer the user still has to make, such as an
 * invoice to pay. The HybridAI app shows it as a card with each detail to copy
 * and a GiroCode (EPC QR code) the user's banking app can scan. German banking
 * apps take no link that opens a filled-in transfer, so this card is the
 * handover. The tool only writes one JSON file into `transfers/` and returns it
 * as an artifact with its own media type; it pays nothing.
 */
import { createHash } from 'node:crypto';

import type { ToolDefinition } from '../types.js';

export const DRAFT_TRANSFER_TOOL = 'draft_transfer';
export const TRANSFER_MIME_TYPE = 'application/vnd.hybridai.transfer+json';

// The GiroCode's limits (EPC069-12, version 002).
const NAME_MAX = 70;
const REFERENCE_MAX = 140;
const AMOUNT_MAX = 999_999_999.99;

export interface Transfer {
  name: string;
  iban: string;
  bic?: string;
  /** Euros with two decimals, such as `37.20`; absent when the user fills it in. */
  amount?: string;
  currency: 'EUR';
  reference?: string;
}

function oneLine(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`\`${field}\` must be text.`);
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.length > max)
    throw new Error(`\`${field}\` must be at most ${max} characters.`);
  return text;
}

/** ISO 13616: two letters, two check digits, up to 30 letters or digits; mod 97 is 1. */
export function isValidIban(iban: string): boolean {
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const char of moved) {
    const digits = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits) rest = (rest * 10 + Number(digit)) % 97;
  }
  return rest === 1;
}

function amountOf(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text =
    typeof value === 'number'
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : '';
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) {
    throw new Error(
      '`amount` must be the sum in euros as a number, such as 37.2.',
    );
  }
  const amount = Number(text);
  if (amount < 0.01 || amount > AMOUNT_MAX) {
    throw new Error('`amount` must be between 0.01 and 999999999.99 euros.');
  }
  return amount.toFixed(2);
}

export function normalizeTransfer(args: Record<string, unknown>): Transfer {
  const name = oneLine(args.name, 'name', NAME_MAX);
  if (!name) throw new Error('`name`, the recipient, is required.');
  const iban = oneLine(args.iban, 'iban', 64).replace(/\s/g, '').toUpperCase();
  if (!iban) throw new Error('`iban` is required.');
  if (!isValidIban(iban)) {
    throw new Error(
      '`iban` is not a valid IBAN; its check digits do not match. Copy it again from the invoice and never guess one.',
    );
  }
  const bic = oneLine(args.bic, 'bic', 11).replace(/\s/g, '').toUpperCase();
  if (bic && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)) {
    throw new Error('`bic` must have 8 or 11 letters and digits.');
  }
  const currency = oneLine(args.currency, 'currency', 3).toUpperCase();
  if (currency && currency !== 'EUR') {
    throw new Error(
      'A GiroCode holds euros only; give the details in your reply instead.',
    );
  }
  const amount = amountOf(args.amount);
  const reference = oneLine(args.reference, 'reference', REFERENCE_MAX);
  return {
    name,
    iban,
    ...(bic ? { bic } : {}),
    ...(amount ? { amount } : {}),
    currency: 'EUR',
    ...(reference ? { reference } : {}),
  };
}

export function transferFilePath(transfer: Transfer): string {
  const slug =
    transfer.name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'transfer';
  const hash = createHash('sha256')
    .update(JSON.stringify(transfer))
    .digest('hex')
    .slice(0, 8);
  return `transfers/${slug}-${hash}.json`;
}

export function runDraftTransfer(
  args: Record<string, unknown>,
  writeFile: (relativePath: string, contents: string) => void,
): string {
  const transfer = normalizeTransfer(args);
  const relativePath = transferFilePath(transfer);
  writeFile(relativePath, `${JSON.stringify(transfer, null, 2)}\n`);
  return JSON.stringify({
    success: true,
    path: relativePath,
    note: 'The app shows this transfer as a card under your reply, with each detail to copy and a GiroCode for the user’s banking app. Nothing was paid. Say in one short sentence what it pays, and ask the user to check recipient, IBAN and amount against the invoice before they approve it in their bank. Do not repeat the details or link the file: the card is the handover to their banking app.',
    artifacts: [
      {
        path: relativePath,
        filename: `${transfer.name}.json`,
        mimeType: TRANSFER_MIME_TYPE,
      },
    ],
  });
}

export const DRAFT_TRANSFER_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: DRAFT_TRANSFER_TOOL,
    description:
      'Prepare a SEPA bank transfer in euros for the user to make in their own banking app, such as paying an invoice, a bill or a reminder. The app shows a card with each detail to copy and a GiroCode their banking app can scan. Use it whenever the user wants to pay or transfer money, instead of writing the details in your reply. Take every detail from the invoice, email or the user; never guess an IBAN or an amount. This pays nothing.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The recipient (account holder) as on the invoice',
        },
        iban: {
          type: 'string',
          description: 'The recipient’s IBAN, spaces allowed',
        },
        bic: {
          type: 'string',
          description: 'The recipient’s BIC, only when the invoice gives it',
        },
        amount: {
          type: 'number',
          description:
            'The sum in euros, such as 37.2; leave it out when the user decides the amount',
        },
        reference: {
          type: 'string',
          description:
            'The payment reference (Verwendungszweck) exactly as the invoice asks for it, such as invoice and customer number',
        },
      },
      required: ['name', 'iban'],
    },
  },
};
