import { createHmac } from 'node:crypto';
import { sinceTimestamp } from '../date-utils.js';
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
  if (!/\d/u.test(compact)) {
    throw new Error(`Unable to parse invoice money value: ${value}`);
  }
  const lastComma = compact.lastIndexOf(',');
  const lastDot = compact.lastIndexOf('.');
  let decimalSeparator = '';

  if (lastComma >= 0 && lastDot >= 0) {
    decimalSeparator = lastDot > lastComma ? '.' : ',';
  } else {
    const separator = lastDot >= 0 ? '.' : lastComma >= 0 ? ',' : '';
    if (separator) {
      const firstIndex = compact.indexOf(separator);
      const lastIndex = compact.lastIndexOf(separator);
      if (firstIndex === lastIndex) {
        const digitsAfter = compact
          .slice(lastIndex + 1)
          .replace(/\D/g, '').length;
        const digitsBefore = compact
          .slice(0, lastIndex)
          .replace(/\D/g, '').length;
        decimalSeparator =
          digitsAfter === 3 && digitsBefore > 0 ? '' : separator;
      }
    }
  }

  let normalized = compact;
  if (decimalSeparator) {
    const thousandsSeparator = decimalSeparator === '.' ? ',' : '.';
    normalized = normalized.split(thousandsSeparator).join('');
    if (decimalSeparator === ',') {
      normalized = normalized.replace(',', '.');
    }
  } else {
    normalized = normalized.replace(/[.,]/g, '');
  }
  normalized = normalized.replace(/[^0-9.-]/g, '');
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Unable to parse invoice money value: ${value}`);
  }
  return parsed;
}

async function loadPlaywright(): Promise<PlaywrightModule> {
  const specifier = 'playwright';
  return import(specifier) as Promise<PlaywrightModule>;
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
        // Keep this browser-context parser in sync with parseInvoiceMoneyText.
        const numberFromText = (value: string): number => {
          const compact = value.replace(/[^0-9,.-]/g, '');
          if (!/\d/u.test(compact)) {
            throw new Error(`Unable to parse invoice money value: ${value}`);
          }
          const lastComma = compact.lastIndexOf(',');
          const lastDot = compact.lastIndexOf('.');
          let decimalSeparator = '';
          if (lastComma >= 0 && lastDot >= 0) {
            decimalSeparator = lastDot > lastComma ? '.' : ',';
          } else {
            const separator = lastDot >= 0 ? '.' : lastComma >= 0 ? ',' : '';
            if (separator) {
              const firstIndex = compact.indexOf(separator);
              const lastIndex = compact.lastIndexOf(separator);
              if (firstIndex === lastIndex) {
                const digitsAfter = compact
                  .slice(lastIndex + 1)
                  .replace(/\D/g, '').length;
                const digitsBefore = compact
                  .slice(0, lastIndex)
                  .replace(/\D/g, '').length;
                decimalSeparator =
                  digitsAfter === 3 && digitsBefore > 0 ? '' : separator;
              }
            }
          }
          let normalized = compact;
          if (decimalSeparator) {
            const thousandsSeparator = decimalSeparator === '.' ? ',' : '.';
            normalized = normalized.split(thousandsSeparator).join('');
            if (decimalSeparator === ',') {
              normalized = normalized.replace(',', '.');
            }
          } else {
            normalized = normalized.replace(/[.,]/g, '');
          }
          normalized = normalized.replace(/[^0-9.-]/g, '');
          const parsed = Number.parseFloat(normalized);
          if (!Number.isFinite(parsed)) {
            throw new Error(`Unable to parse invoice money value: ${value}`);
          }
          return parsed;
        };
        const currencyFromText = (value: string): string => {
          const upper = value.toUpperCase();
          const match = upper.match(/\b[A-Z]{3}\b/u);
          if (match?.[0]) return match[0];
          if (upper.includes('€')) return 'EUR';
          if (upper.includes('$')) return 'USD';
          throw new Error(`Unable to parse invoice currency value: ${value}`);
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
          };
        });
      },
      evaluationPlan,
    );
    const since = sinceTimestamp(options, 'scrape invoice since date');
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
      { sourceUrl: string; allowedHosts: string[] }
    >(
      async (_invoiceNo, params) => {
        let url: URL;
        try {
          url = new URL(params.sourceUrl, window.location.href);
        } catch {
          return { base64: '', contentType: '', status: 0 };
        }
        if (
          url.protocol !== 'https:' ||
          !params.allowedHosts.includes(url.hostname)
        ) {
          return { base64: '', contentType: 'blocked-url', status: 0 };
        }
        const response = await fetch(url.href);
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
      {
        sourceUrl: invoice.source_url,
        allowedHosts: Array.from(
          new Set([
            new URL(this.#plan.loginUrl).hostname,
            new URL(this.#plan.billingUrl).hostname,
          ]),
        ),
      },
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
