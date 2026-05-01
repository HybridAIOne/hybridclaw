import { createHmac } from 'node:crypto';

import type {
  InvoiceAdapterContext,
  InvoiceCredentials,
  InvoiceListOptions,
  InvoiceMeta,
} from '../types.js';
import type { ScrapeInvoiceDriver } from './dashboard-scrape.js';

type PlaywrightModule = {
  chromium: {
    launchPersistentContext(
      profileDir: string,
      options: { headless: boolean },
    ): Promise<BrowserContextLike>;
  };
};

type BrowserContextLike = {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
};

type PageLike = {
  goto(url: string, options?: { waitUntil?: string }): Promise<unknown>;
  fill(selector: string, value: string): Promise<unknown>;
  click(selector: string): Promise<unknown>;
  waitForSelector(
    selector: string,
    options?: { timeout?: number },
  ): Promise<unknown>;
  $$eval<T, Arg>(
    selector: string,
    pageFunction: (elements: Element[], arg: Arg) => T,
    arg: Arg,
  ): Promise<T>;
  evaluate<T, Arg>(
    pageFunction: (invoiceNo: string, arg: Arg) => T | Promise<T>,
    invoiceNo: string,
    arg: Arg,
  ): Promise<T>;
};

export interface ScrapeInvoicePlan {
  loginUrl: string;
  billingUrl: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  invoiceRowSelector: string;
  invoiceNoSelector: string;
  issueDateSelector: string;
  dueDateSelector: string;
  periodSelector: string;
  netSelector: string;
  vatSelector: string;
  grossSelector: string;
  currencySelector: string;
  pdfLinkSelector: string;
  totpSelector?: string;
  captchaSelector?: string;
}

type ScrapeInvoiceEvaluationPlan = ScrapeInvoicePlan & {
  vendor: string;
};

interface BrowserDownloadResult {
  base64: string;
  contentType: string;
  status: number;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(value: string): Buffer {
  const normalized = value.toUpperCase().replace(/[^A-Z2-7]/gu, '');
  let bits = '';
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) continue;
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTotp(secret: string, now = Date.now()): string {
  const counter = Math.floor(now / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuffer.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', decodeBase32(secret))
    .update(counterBuffer)
    .digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

export function parseInvoiceMoneyText(value: string): number {
  const compact = value.replace(/[^0-9,.-]/g, '');
  const lastComma = compact.lastIndexOf(',');
  const lastDot = compact.lastIndexOf('.');
  const decimalIndex = Math.max(lastComma, lastDot);
  if (decimalIndex < 0) {
    const parsed = Number.parseFloat(compact.replace(/[^0-9-]/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  const decimalSeparator = compact[decimalIndex];
  const fraction = compact.slice(decimalIndex + 1).replace(/\D/g, '');
  const whole = compact.slice(0, decimalIndex).replace(/[^0-9-]/g, '');
  const separatorIsThousandsOnly =
    fraction.length === 3 &&
    compact.slice(0, decimalIndex).replace(/\D/g, '').length > 0 &&
    (lastComma < 0 || lastDot < 0);
  const normalized = separatorIsThousandsOnly
    ? `${whole}${fraction}`
    : `${whole}${decimalSeparator ? '.' : ''}${fraction}`;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function loadPlaywright(): Promise<PlaywrightModule> {
  const dynamicImport = new Function(
    'specifier',
    'return import(specifier)',
  ) as (specifier: string) => Promise<PlaywrightModule>;
  return dynamicImport('playwright');
}

export class PlaywrightScrapeInvoiceDriver implements ScrapeInvoiceDriver {
  readonly #plan: ScrapeInvoicePlan;
  #context: BrowserContextLike | null = null;
  #page: PageLike | null = null;
  #providerId: string | null = null;

  constructor(plan: ScrapeInvoicePlan) {
    this.#plan = plan;
  }

  async login(
    credentials: InvoiceCredentials,
    context: InvoiceAdapterContext,
  ): Promise<void> {
    if (!context.profileDir) {
      throw new Error('Scrape invoice adapters require context.profileDir.');
    }
    this.#providerId = context.providerId;
    if (!credentials.username || !credentials.password) {
      throw new Error('Scrape invoice adapters require username and password.');
    }

    const playwright = await loadPlaywright();
    this.#context = await playwright.chromium.launchPersistentContext(
      context.profileDir,
      { headless: true },
    );
    this.#page = await this.#context.newPage();
    await this.#page.goto(this.#plan.loginUrl, {
      waitUntil: 'domcontentloaded',
    });
    await this.#page.fill(this.#plan.usernameSelector, credentials.username);
    await this.#page.fill(this.#plan.passwordSelector, credentials.password);
    await this.#page.click(this.#plan.submitSelector);
    if (this.#plan.captchaSelector) {
      try {
        await this.#page.waitForSelector(this.#plan.captchaSelector, {
          timeout: 1000,
        });
        throw new Error(
          'Captcha detected during invoice portal login; operator escalation required.',
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('operator escalation required')
        ) {
          throw error;
        }
      }
    }
    if (this.#plan.totpSelector && credentials.totpSecret) {
      await this.#page.waitForSelector(this.#plan.totpSelector);
      await this.#page.fill(
        this.#plan.totpSelector,
        generateTotp(credentials.totpSecret),
      );
      await this.#page.click(this.#plan.submitSelector);
    }
    await this.#page.goto(this.#plan.billingUrl, {
      waitUntil: 'domcontentloaded',
    });
  }

  async listInvoices(options: InvoiceListOptions): Promise<InvoiceMeta[]> {
    if (!this.#page) {
      throw new Error('Scrape invoice session is not logged in.');
    }
    const evaluationPlan: ScrapeInvoiceEvaluationPlan = {
      ...this.#plan,
      vendor: this.#providerId || new URL(this.#plan.billingUrl).hostname,
    };
    const invoices = await this.#page.$$eval(
      this.#plan.invoiceRowSelector,
      (rows, plan) => {
        const textContent = (root: Element, selector: string): string =>
          (root.querySelector(selector)?.textContent || '').trim();
        const numberFromText = (value: string): number => {
          const compact = value.replace(/[^0-9,.-]/g, '');
          const lastComma = compact.lastIndexOf(',');
          const lastDot = compact.lastIndexOf('.');
          const decimalIndex = Math.max(lastComma, lastDot);
          if (decimalIndex < 0) {
            const parsed = Number.parseFloat(compact.replace(/[^0-9-]/g, ''));
            return Number.isFinite(parsed) ? parsed : 0;
          }
          const decimalSeparator = compact[decimalIndex];
          const fraction = compact.slice(decimalIndex + 1).replace(/\D/g, '');
          const whole = compact.slice(0, decimalIndex).replace(/[^0-9-]/g, '');
          const separatorIsThousandsOnly =
            fraction.length === 3 &&
            compact.slice(0, decimalIndex).replace(/\D/g, '').length > 0 &&
            (lastComma < 0 || lastDot < 0);
          const normalized = separatorIsThousandsOnly
            ? `${whole}${fraction}`
            : `${whole}${decimalSeparator ? '.' : ''}${fraction}`;
          const parsed = Number.parseFloat(normalized);
          return Number.isFinite(parsed) ? parsed : 0;
        };
        const currencyFromText = (value: string): string => {
          const upper = value.toUpperCase();
          const match = upper.match(/\b[A-Z]{3}\b/u);
          if (match) return match[0] || 'EUR';
          if (upper.includes('€')) return 'EUR';
          if (upper.includes('$')) return 'USD';
          return 'EUR';
        };
        return rows.map((row) => {
          const invoiceNo = textContent(row, plan.invoiceNoSelector);
          const net = numberFromText(textContent(row, plan.netSelector));
          const vat = numberFromText(textContent(row, plan.vatSelector));
          const gross = numberFromText(textContent(row, plan.grossSelector));
          const pdfHref =
            row.querySelector<HTMLAnchorElement>(plan.pdfLinkSelector)?.href ||
            plan.billingUrl;
          return {
            vendor: plan.vendor,
            invoice_no: invoiceNo,
            period: textContent(row, plan.periodSelector),
            issue_date: textContent(row, plan.issueDateSelector),
            due_date: textContent(row, plan.dueDateSelector),
            net,
            vat_rate: net > 0 ? Number((vat / net).toFixed(4)) : 0,
            vat,
            gross,
            currency: currencyFromText(textContent(row, plan.currencySelector)),
            source_url: pdfHref,
            suggested_file_name: `${invoiceNo}.pdf`,
          };
        });
      },
      evaluationPlan,
    );
    const since = options.since ? new Date(options.since).getTime() : null;
    return invoices.filter((invoice) => {
      if (since == null) return true;
      return new Date(invoice.issue_date).getTime() >= since;
    });
  }

  async downloadInvoice(invoice: InvoiceMeta): Promise<Uint8Array> {
    if (!this.#page) {
      throw new Error('Scrape invoice session is not logged in.');
    }
    const result = await this.#page.evaluate<
      BrowserDownloadResult,
      ScrapeInvoicePlan
    >(
      async (invoiceNo, plan) => {
        const rows = Array.from(
          document.querySelectorAll(plan.invoiceRowSelector),
        );
        const row = rows.find((candidate) =>
          (candidate.querySelector(plan.invoiceNoSelector)?.textContent || '')
            .trim()
            .includes(invoiceNo),
        );
        const href =
          row
            ?.querySelector<HTMLAnchorElement>(plan.pdfLinkSelector)
            ?.getAttribute('href') || '';
        if (!href) {
          return { base64: '', contentType: '', status: 0 };
        }
        const response = await fetch(href);
        const contentType = response.headers.get('content-type') || '';
        if (
          !response.ok ||
          (contentType &&
            !contentType.toLowerCase().includes('pdf') &&
            !contentType.toLowerCase().includes('octet-stream'))
        ) {
          return {
            base64: '',
            contentType,
            status: response.status,
          };
        }
        const buffer = await response.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return {
          base64: btoa(binary),
          contentType,
          status: response.status,
        };
      },
      invoice.invoice_no,
      this.#plan,
    );
    if (!result.base64) {
      throw new Error(
        `Invoice PDF download failed for ${invoice.invoice_no}: HTTP ${result.status || 'unknown'} ${result.contentType || 'unknown content type'}.`,
      );
    }
    return Buffer.from(result.base64, 'base64');
  }

  async close(): Promise<void> {
    await this.#context?.close();
    this.#context = null;
    this.#page = null;
  }
}
