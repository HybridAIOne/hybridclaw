const path = require('node:path');

const DATEV_UNTERNEHMEN_ONLINE_UPLOAD_PLAN = {
  loginUrl: 'https://apps.datev.de/mydatev',
  documentsUrl: 'https://duo.datev.de/duo/',
  usernameSelector: 'input[name="username"], input[type="email"]',
  passwordSelector: 'input[name="password"], input[type="password"]',
  submitSelector: 'button[type="submit"]',
  uploadButtonSelector:
    '[aria-label*="Belege hochladen" i], button:has-text("Belege hochladen"), a:has-text("Belege hochladen"), button:has-text("Upload")',
  fileInputSelector:
    'input[type="file"][accept*="pdf" i], input[type="file"][accept*="tif" i], input[type="file"]',
  uploadSubmitSelector:
    '[aria-label*="Hochladen" i], button[type="submit"], button:has-text("Hochladen"), button:has-text("Upload")',
  successSelector:
    '[data-upload-success], [role="status"]:has-text("hochgeladen"), text=/hochgeladen|uploaded/i',
  evidence: {
    sourceUrl:
      'https://www.datev.de/web/de/steuerberatung/loesungen/rechnungswesen/belege-und-daten-digital-in-die-kanzlei-uebertragen/digital-zusammenarbeiten/belege-mit-mandanten-austauschen',
    requiredLabels: ['Belege hochladen'],
  },
};

class DatevUnternehmenOnlineUploadAdapter {
  constructor(options) {
    this.credentials = options.credentials;
    this.profileDir = options.profileDir;
    this.apiClient = options.apiClient || options.dataServiceClient || null;
    this.mcpClient = options.mcpClient || null;
    this.id = 'datev-unternehmen-online';
    this.unverifiedSelectors = !this.apiClient && !this.mcpClient;
    this.driver =
      options.driver ||
      new PlaywrightDatevUnternehmenOnlineUploadDriver(
        options.plan || DATEV_UNTERNEHMEN_ONLINE_UPLOAD_PLAN,
      );
  }

  async uploadInvoices(params) {
    if (this.apiClient) {
      return uploadInvoicesViaDatevApiClient(this.apiClient, params);
    }
    if (this.mcpClient) {
      return uploadInvoicesViaDatevMcpClient(this.mcpClient, params);
    }
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

async function uploadInvoicesViaDatevApiClient(client, params) {
  for (const record of params.records) {
    const pdfPath = resolveInvoicePdfPath({
      record,
      outputDir: params.outputDir,
      invoiceRoots: params.invoiceRoots,
    });
    if (typeof client.uploadInvoice === 'function') {
      await client.uploadInvoice({ record, pdfPath, workflowId: params.workflowId });
    } else if (typeof client.uploadDocument === 'function') {
      await client.uploadDocument({ record, pdfPath, workflowId: params.workflowId });
    } else if (typeof client.createAttachment === 'function') {
      await client.createAttachment({ record, pdfPath, workflowId: params.workflowId });
    } else {
      throw new Error(
        'DATEV API client must expose uploadInvoice, uploadDocument, or createAttachment.',
      );
    }
  }
}

async function uploadInvoicesViaDatevMcpClient(client, params) {
  if (typeof client.callTool !== 'function') {
    throw new Error('DATEV MCP client must expose callTool(name, args).');
  }
  for (const record of params.records) {
    const pdfPath = resolveInvoicePdfPath({
      record,
      outputDir: params.outputDir,
      invoiceRoots: params.invoiceRoots,
    });
    await client.callTool('accounting_attachments_add', {
      workflowId: params.workflowId,
      file_path: pdfPath,
      file_name: `${record.vendor}-${record.invoice_no}.pdf`,
      mime_type: 'application/pdf',
      metadata: {
        vendor: record.vendor,
        invoice_no: record.invoice_no,
        period: record.period,
        issue_date: record.issue_date,
        due_date: record.due_date,
        gross: record.gross,
        currency: record.currency,
      },
    });
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

function verifyDatevUploadPlanAgainstSnapshot(plan, snapshot) {
  const text = String(snapshot?.text || snapshot || '');
  const labels = plan.evidence?.requiredLabels || [];
  const missing = labels.filter((label) => !text.includes(label));
  if (missing.length > 0) {
    throw new Error(
      `DATEV upload plan snapshot is missing labels: ${missing.join(', ')}`,
    );
  }
  return true;
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
  uploadInvoicesViaDatevApiClient,
  uploadInvoicesViaDatevMcpClient,
  verifyDatevUploadPlanAgainstSnapshot,
};
