import path from 'node:path';

import type { DatevInvoiceUploadAdapter } from './monthly-run.js';
import type { InvoiceCredentials, InvoiceRecord } from './types.js';

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
  setInputFiles(selector: string, files: string | string[]): Promise<unknown>;
  waitForSelector(
    selector: string,
    options?: { timeout?: number },
  ): Promise<unknown>;
};

export interface DatevUploadPlan {
  loginUrl: string;
  documentsUrl: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  uploadButtonSelector?: string;
  fileInputSelector: string;
  uploadSubmitSelector?: string;
  successSelector?: string;
}

export interface DatevUploadInvoiceInput {
  record: InvoiceRecord;
  pdfPath: string;
}

export interface DatevUploadSession {
  close?: () => void | Promise<void>;
}

export interface DatevUnternehmenOnlineUploadDriver<
  Session extends DatevUploadSession = DatevUploadSession,
> {
  login(input: {
    credentials: InvoiceCredentials;
    profileDir?: string;
  }): Promise<Session>;
  uploadInvoice(
    session: Session,
    input: DatevUploadInvoiceInput,
  ): Promise<void>;
  close?(session: Session): void | Promise<void>;
}

export const DATEV_UNTERNEHMEN_ONLINE_UPLOAD_PLAN: DatevUploadPlan = {
  loginUrl: 'https://apps.datev.de/mydatev',
  documentsUrl: 'https://apps.datev.de/mydatev',
  usernameSelector: 'input[name="username"], input[type="email"]',
  passwordSelector: 'input[name="password"], input[type="password"]',
  submitSelector: 'button[type="submit"]',
  uploadButtonSelector:
    'button:has-text("Belege hochladen"), button:has-text("Upload")',
  fileInputSelector: 'input[type="file"]',
  uploadSubmitSelector: 'button[type="submit"], button:has-text("Hochladen")',
  successSelector: '[data-upload-success], text=/hochgeladen|uploaded/i',
};

export class DatevUnternehmenOnlineUploadAdapter
  implements DatevInvoiceUploadAdapter
{
  readonly #credentials: InvoiceCredentials;
  readonly #profileDir?: string;
  readonly #driver: DatevUnternehmenOnlineUploadDriver;

  constructor(options: {
    credentials: InvoiceCredentials;
    profileDir?: string;
    driver?: DatevUnternehmenOnlineUploadDriver;
    plan?: DatevUploadPlan;
  }) {
    this.#credentials = options.credentials;
    this.#profileDir = options.profileDir;
    this.#driver =
      options.driver ||
      new PlaywrightDatevUnternehmenOnlineUploadDriver(
        options.plan || DATEV_UNTERNEHMEN_ONLINE_UPLOAD_PLAN,
      );
  }

  async uploadInvoices(params: {
    workflowId: string;
    records: InvoiceRecord[];
    outputDir: string;
    invoiceRoots: Array<{
      vendor: string;
      invoice_no: string;
      outputDir: string;
    }>;
  }): Promise<void> {
    const session = await this.#driver.login({
      credentials: this.#credentials,
      profileDir: this.#profileDir,
    });
    try {
      for (const record of params.records) {
        await this.#driver.uploadInvoice(session, {
          record,
          pdfPath: resolveInvoicePdfPath({
            record,
            outputDir: params.outputDir,
            invoiceRoots: params.invoiceRoots,
          }),
        });
      }
    } finally {
      if (typeof this.#driver.close === 'function') {
        await this.#driver.close(session);
      } else {
        await session.close?.();
      }
    }
  }
}

export function resolveInvoicePdfPath(input: {
  record: InvoiceRecord;
  outputDir: string;
  invoiceRoots: Array<{
    vendor: string;
    invoice_no: string;
    outputDir: string;
  }>;
}): string {
  const root =
    input.invoiceRoots.find(
      (candidate) =>
        candidate.vendor === input.record.vendor &&
        candidate.invoice_no === input.record.invoice_no,
    )?.outputDir || input.outputDir;
  const targetPath = path.resolve(root, input.record.pdf_path);
  const rootPath = path.resolve(root);
  if (!targetPath.startsWith(rootPath + path.sep)) {
    throw new Error(
      `DATEV invoice PDF path escapes output directory: ${input.record.pdf_path}`,
    );
  }
  return targetPath;
}

export class PlaywrightDatevUnternehmenOnlineUploadDriver
  implements DatevUnternehmenOnlineUploadDriver<BrowserContextLike>
{
  readonly #plan: DatevUploadPlan;

  constructor(plan: DatevUploadPlan = DATEV_UNTERNEHMEN_ONLINE_UPLOAD_PLAN) {
    this.#plan = plan;
  }

  async login(input: {
    credentials: InvoiceCredentials;
    profileDir?: string;
  }): Promise<BrowserContextLike> {
    if (!input.profileDir) {
      throw new Error('DATEV Unternehmen Online upload requires profileDir.');
    }
    if (!input.credentials.username || !input.credentials.password) {
      throw new Error(
        'DATEV Unternehmen Online upload requires credentials.username and credentials.password.',
      );
    }
    const playwright = await loadPlaywright();
    const context = await playwright.chromium.launchPersistentContext(
      input.profileDir,
      { headless: true },
    );
    const page = await context.newPage();
    await page.goto(this.#plan.loginUrl, { waitUntil: 'domcontentloaded' });
    await page.fill(this.#plan.usernameSelector, input.credentials.username);
    await page.fill(this.#plan.passwordSelector, input.credentials.password);
    await page.click(this.#plan.submitSelector);
    return context;
  }

  async uploadInvoice(
    session: BrowserContextLike,
    input: DatevUploadInvoiceInput,
  ): Promise<void> {
    const page = await session.newPage();
    await page.goto(this.#plan.documentsUrl, { waitUntil: 'domcontentloaded' });
    if (this.#plan.uploadButtonSelector) {
      try {
        await page.click(this.#plan.uploadButtonSelector);
      } catch {
        // Some DATEV tenants expose the file input directly.
      }
    }
    await page.setInputFiles(this.#plan.fileInputSelector, input.pdfPath);
    if (this.#plan.uploadSubmitSelector) {
      await page.click(this.#plan.uploadSubmitSelector);
    }
    if (this.#plan.successSelector) {
      await page.waitForSelector(this.#plan.successSelector, {
        timeout: 30_000,
      });
    }
  }

  async close(session: BrowserContextLike): Promise<void> {
    await session.close();
  }
}

async function loadPlaywright(): Promise<PlaywrightModule> {
  const specifier = 'playwright';
  return import(specifier) as Promise<PlaywrightModule>;
}
