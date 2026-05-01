const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { emitInvoiceFetchedAudit, makeAuditRunId } = require('./helpers/audit.cjs');
const { validateInvoiceRecord } = require('./helpers/schema.cjs');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safePathPart(value) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'invoice';
}

function invoicePdfRelativePath(invoice) {
  const fileName = safePathPart(`${invoice.invoice_no}.pdf`);
  const pdfName = fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`;
  return path.posix.join(
    'runs',
    invoice.period,
    safePathPart(invoice.vendor),
    pdfName,
  );
}

function writeInvoicePdf(outputDir, relativePath, bytes) {
  const targetPath = path.resolve(outputDir, relativePath);
  const outputRoot = path.resolve(outputDir);
  if (!targetPath.startsWith(outputRoot + path.sep)) {
    throw new Error(`Invoice PDF path escapes output directory: ${relativePath}`);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(targetPath, bytes, { mode: 0o600 });
}

function createInvoiceIdentity(invoice) {
  return `${invoice.vendor.trim().toLowerCase()}\u0000${invoice.invoice_no.trim()}`;
}

function loadInvoiceManifest(filePath) {
  if (!fs.existsSync(filePath)) {
    return { schema: 'hybridclaw.invoice-manifest.v1', records: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    throw new Error(`Invalid invoice manifest at ${filePath}: ${error.message}`);
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    parsed.schema !== 'hybridclaw.invoice-manifest.v1' ||
    !Array.isArray(parsed.records)
  ) {
    throw new Error(`Invalid invoice manifest at ${filePath}.`);
  }

  return {
    schema: 'hybridclaw.invoice-manifest.v1',
    records: parsed.records.map(validateInvoiceRecord),
  };
}

function saveInvoiceManifest(filePath, manifest) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;

  try {
    fs.writeFileSync(tempFilePath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    fs.renameSync(tempFilePath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
}

function createInvoiceDuplicateIndex(records) {
  return {
    identities: new Set(records.map(createInvoiceIdentity)),
    checksums: new Set(records.map((record) => record.checksum_sha256)),
  };
}

function addInvoiceRecordToDuplicateIndex(index, record) {
  index.identities.add(createInvoiceIdentity(record));
  index.checksums.add(record.checksum_sha256);
}

function findInvoiceDuplicateInIndex(invoice, index) {
  if (index.identities.has(createInvoiceIdentity(invoice))) {
    return { reason: 'identity', invoice };
  }
  if ('checksum_sha256' in invoice && index.checksums.has(invoice.checksum_sha256)) {
    return { reason: 'checksum', invoice };
  }
  return null;
}

function buildInvoiceRecord(input) {
  return validateInvoiceRecord({
    ...input.invoice,
    pdf_path: input.pdfPath,
    checksum_sha256: input.checksumSha256,
  });
}

async function harvestProviderInvoices(input) {
  const manifestPath =
    input.manifestPath || path.join(input.outputDir, 'manifest.json');
  const manifest = loadInvoiceManifest(manifestPath);
  const duplicateIndex = createInvoiceDuplicateIndex(manifest.records);
  const duplicates = [];
  const fetched = [];
  let session;

  try {
    session = await input.adapter.login(input.credentials, {
      providerId: input.adapter.id,
      profileDir: input.profileDir,
    });
    const invoices = await input.adapter.listInvoices(
      session,
      input.listOptions || {},
    );

    for (const invoice of invoices) {
      const identityDuplicate = findInvoiceDuplicateInIndex(invoice, duplicateIndex);
      if (identityDuplicate) {
        duplicates.push(identityDuplicate);
        continue;
      }

      const bytes = await input.adapter.download(session, invoice);
      const relativePath = invoicePdfRelativePath(invoice);
      const record = buildInvoiceRecord({
        invoice,
        pdfPath: relativePath,
        checksumSha256: sha256(bytes),
      });
      const checksumDuplicate = findInvoiceDuplicateInIndex(record, duplicateIndex);
      if (checksumDuplicate) {
        duplicates.push(checksumDuplicate);
        continue;
      }

      writeInvoicePdf(input.outputDir, relativePath, bytes);
      fetched.push(record);
      addInvoiceRecordToDuplicateIndex(duplicateIndex, record);
      if (input.sessionId) {
        emitInvoiceFetchedAudit({
          sessionId: input.sessionId,
          runId: input.runId,
          record,
          recordAudit: input.recordAudit,
        });
      }
    }

    if (fetched.length > 0) {
      manifest.records.push(...fetched);
      saveInvoiceManifest(manifestPath, manifest);
    } else if (!fs.existsSync(manifestPath)) {
      saveInvoiceManifest(manifestPath, manifest);
    }

    return { fetched, duplicates, manifestPath };
  } finally {
    if (session !== undefined) {
      if (typeof input.adapter.close === 'function') {
        await input.adapter.close(session);
      } else {
        await session?.close?.();
      }
    }
  }
}

async function runMonthlyInvoiceRun(input) {
  const runId = makeAuditRunId('monthly-invoice');
  const audit = input.recordAudit || (() => undefined);
  const adaptersById = new Map(input.adapters.map((adapter) => [adapter.id, adapter]));
  const providerResults = [];
  const providerErrors = [];
  const invoiceRoots = [];
  const providers = input.config.providers.filter(
    (provider) => provider.enabled !== false,
  );

  for (const provider of providers) {
    const adapter = adaptersById.get(provider.id);
    if (!adapter) throw new Error(`Invoice adapter ${provider.id} is not registered.`);
    const outputDir = provider.outputDir || input.config.outputDir;
    try {
      const result = await harvestProviderInvoices({
        adapter,
        credentials: provider.credentials || {},
        outputDir,
        manifestPath: path.join(outputDir, 'manifest.json'),
        listOptions: { since: provider.since },
        profileDir: provider.profileDir,
        sessionId: input.sessionId,
        runId,
        recordAudit: audit,
      });
      providerResults.push({ providerId: provider.id, result });
      invoiceRoots.push(
        ...result.fetched.map((record) => ({
          vendor: record.vendor,
          invoice_no: record.invoice_no,
          outputDir,
        })),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      providerErrors.push({ providerId: provider.id, error: message });
      audit({
        sessionId: input.sessionId,
        runId,
        event: {
          type: 'invoice.provider_failed',
          provider: provider.id,
          error: message,
        },
      });
    }
  }

  const records = providerResults.flatMap(({ result }) => result.fetched);
  const shouldUpload = Boolean(input.config.datev?.enabled);
  if (shouldUpload) {
    if (!input.datev) {
      throw new Error('DATEV handoff is enabled but no upload adapter was provided.');
    }
    const workflowId = input.config.datev?.workflowId || 'monthly-invoice-run';
    await input.datev.uploadInvoices({
      workflowId,
      records,
      outputDir: input.config.outputDir,
      invoiceRoots,
    });
    audit({
      sessionId: input.sessionId,
      runId,
      event: {
        type: 'invoice.datev_handoff',
        workflowId,
        invoiceCount: records.length,
      },
    });
  }

  return { runId, providerResults, providerErrors, datevUploaded: shouldUpload };
}

module.exports = {
  buildInvoiceRecord,
  createInvoiceDuplicateIndex,
  createInvoiceIdentity,
  findInvoiceDuplicateInIndex,
  harvestProviderInvoices,
  invoicePdfRelativePath,
  loadInvoiceManifest,
  runMonthlyInvoiceRun,
  saveInvoiceManifest,
};
