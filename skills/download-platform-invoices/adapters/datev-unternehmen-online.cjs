const path = require('node:path');

const DATEV_UNTERNEHMEN_ONLINE_UPLOAD_PLAN = {
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

class DatevUnternehmenOnlineUploadAdapter {
  constructor(options) {
    this.credentials = options.credentials;
    this.profileDir = options.profileDir;
    this.driver =
      options.driver ||
      new PlaywrightDatevUnternehmenOnlineUploadDriver(
        options.plan || DATEV_UNTERNEHMEN_ONLINE_UPLOAD_PLAN,
      );
  }

  async uploadInvoices(params) {
    const session = await this.driver.login({
      credentials: this.credentials,
      profileDir: this.profileDir,
    });
    try {
      for (const record of params.records) {
        await this.driver.uploadInvoice(session, {
          record,
          pdfPath: resolveInvoicePdfPath({
            record,
            outputDir: params.outputDir,
            invoiceRoots: params.invoiceRoots,
          }),
        });
      }
    } finally {
      if (typeof this.driver.close === 'function') {
        await this.driver.close(session);
      } else {
        await session.close?.();
      }
    }
  }
}

function resolveInvoicePdfPath(input) {
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

class PlaywrightDatevUnternehmenOnlineUploadDriver {
  constructor(plan = DATEV_UNTERNEHMEN_ONLINE_UPLOAD_PLAN) {
    this.plan = plan;
  }

  async login(input) {
    if (!input.profileDir) {
      throw new Error('DATEV Unternehmen Online upload requires profileDir.');
    }
    if (!input.credentials.username || !input.credentials.password) {
      throw new Error(
        'DATEV Unternehmen Online upload requires credentials.username and credentials.password.',
      );
    }
    const playwright = await import('playwright');
    const context = await playwright.chromium.launchPersistentContext(
      input.profileDir,
      { headless: true },
    );
    const page = await context.newPage();
    await page.goto(this.plan.loginUrl, { waitUntil: 'domcontentloaded' });
    await page.fill(this.plan.usernameSelector, input.credentials.username);
    await page.fill(this.plan.passwordSelector, input.credentials.password);
    await page.click(this.plan.submitSelector);
    return context;
  }

  async uploadInvoice(session, input) {
    const page = await session.newPage();
    await page.goto(this.plan.documentsUrl, { waitUntil: 'domcontentloaded' });
    if (this.plan.uploadButtonSelector) {
      try {
        await page.click(this.plan.uploadButtonSelector);
      } catch {
        // Some DATEV tenants expose the file input directly.
      }
    }
    await page.setInputFiles(this.plan.fileInputSelector, input.pdfPath);
    if (this.plan.uploadSubmitSelector) await page.click(this.plan.uploadSubmitSelector);
    if (this.plan.successSelector) {
      await page.waitForSelector(this.plan.successSelector, { timeout: 30_000 });
    }
  }

  async close(session) {
    await session.close();
  }
}

module.exports = {
  DATEV_UNTERNEHMEN_ONLINE_UPLOAD_PLAN,
  DatevUnternehmenOnlineUploadAdapter,
  PlaywrightDatevUnternehmenOnlineUploadDriver,
  resolveInvoicePdfPath,
};
