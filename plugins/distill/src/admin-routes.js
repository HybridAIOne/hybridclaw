import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DATA_DIR,
  ensureBootstrapFiles,
  getAgentById,
  readWebhookJsonBody,
  sendWebhookJson,
  upsertRegisteredAgent,
  WebhookHttpError,
} from '@hybridaione/hybridclaw/plugin-sdk';
import {
  consentDigest,
  loadConsentArtefact,
  recordConsentArtefact,
} from './consent.js';
import {
  getCorpusDocument,
  listCorpusDocuments,
  removeCorpusDocument,
} from './corpus.js';
import { ensureDistilledMemoryFile, listReviewItems } from './merge.js';
import {
  normalizeSubjectAlias,
  resolveDistillPaths,
  resolveDistillRunPaths,
} from './paths.js';
import { runDistillPipeline } from './pipeline.js';
import { listDistillRuns } from './run.js';
import {
  ensureSubjectProfile,
  loadSubjectProfile,
  requireSubjectProfile,
} from './subject.js';
import {
  DISTILL_SOURCE_KINDS,
  DISTILL_STAGE_ORDER,
  DistillBlockedError,
} from './types.js';

const ADMIN_DISTILL_FILE_PREVIEW_BYTES = 80_000;
const ADMIN_DISTILL_UPLOAD_PREVIEW_BYTES = 40_000;
const ADMIN_DISTILL_CORPUS_PREVIEW_CHARS = 2_000;

function normalizeOptionalText(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeTextArray(value) {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function normalizeAgentId(value, fallback) {
  return normalizeOptionalText(value) || fallback;
}

function normalizeSourceKind(value) {
  const raw = normalizeOptionalText(value) || 'auto';
  if (![...DISTILL_SOURCE_KINDS, 'correction'].includes(raw)) {
    throw new WebhookHttpError(400, `Unsupported source kind: ${raw}.`);
  }
  return raw;
}

function normalizeAlias(value) {
  const raw = normalizeOptionalText(value);
  if (!raw) {
    throw new WebhookHttpError(400, '`alias` is required.');
  }
  try {
    return normalizeSubjectAlias(raw);
  } catch (error) {
    throw new WebhookHttpError(
      400,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function normalizeCorpusDocumentId(value) {
  const raw = normalizeOptionalText(value);
  if (!raw) {
    throw new WebhookHttpError(400, '`documentId` is required.');
  }
  if (!/^doc_[a-zA-Z0-9_-]+$/.test(raw)) {
    throw new WebhookHttpError(400, 'Invalid corpus document id.');
  }
  return raw;
}

function normalizeHoldoutRatio(value) {
  if (value == null || value === '') return undefined;
  const ratio = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 0.5) {
    throw new WebhookHttpError(
      400,
      '`holdoutRatio` must be a number between 0 and 0.5.',
    );
  }
  return ratio;
}

function requireAdminSubjectProfile(paths) {
  try {
    return requireSubjectProfile(paths);
  } catch (error) {
    throw new WebhookHttpError(
      404,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function summarizeConsent(consent) {
  if (!consent) {
    return {
      present: false,
      valid: false,
      revokedAt: null,
      recordedAt: null,
      grantedBy: null,
      method: null,
      scope: null,
      sha256: null,
    };
  }
  return {
    present: true,
    valid: !consent.revokedAt && consent.sha256 === consentDigest(consent),
    revokedAt: consent.revokedAt || null,
    recordedAt: consent.recordedAt,
    grantedBy: consent.grantedBy,
    method: consent.method,
    scope: consent.scope,
    sha256: consent.sha256,
  };
}

function embeddedTextFromString(content, maxChars) {
  const truncated = content.length > maxChars;
  return {
    available: true,
    content: truncated ? content.slice(0, maxChars) : content,
    byteLength: Buffer.byteLength(content, 'utf-8'),
    truncated,
    error: null,
  };
}

function embeddedTextFromBuffer(buffer, maxBytes) {
  const truncated = buffer.length > maxBytes;
  const visible = truncated ? buffer.subarray(0, maxBytes) : buffer;
  return {
    available: true,
    content: visible.toString('utf-8'),
    byteLength: buffer.length,
    truncated,
    error: null,
  };
}

function readEmbeddedTextFile(filePath) {
  try {
    const file = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(file);
      const bytesToRead = Math.min(stat.size, ADMIN_DISTILL_FILE_PREVIEW_BYTES);
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(file, buffer, 0, bytesToRead, 0);
      return {
        available: true,
        content: buffer.toString('utf-8'),
        byteLength: stat.size,
        truncated: stat.size > ADMIN_DISTILL_FILE_PREVIEW_BYTES,
        error: null,
      };
    } finally {
      fs.closeSync(file);
    }
  } catch (error) {
    return {
      available: false,
      content: '',
      byteLength: 0,
      truncated: false,
      error:
        error.code === 'ENOENT'
          ? 'Not generated yet.'
          : error.message || 'Unable to read artifact.',
    };
  }
}

function summarizeCorpusDocument(document) {
  return {
    id: document.id,
    source: document.source,
    origin: document.origin,
    author: document.author,
    authoredBySubject: document.authoredBySubject,
    ...(document.title ? { title: document.title } : {}),
    ...(document.channel ? { channel: document.channel } : {}),
    ...(document.timestamp ? { timestamp: document.timestamp } : {}),
    wordCount: document.wordCount,
    weight: document.weight,
    holdout: Boolean(document.holdout),
    runId: document.runId || null,
    contentPreview: embeddedTextFromString(
      document.content,
      ADMIN_DISTILL_CORPUS_PREVIEW_CHARS,
    ),
  };
}

function summarizeRun(agentId, run) {
  const paths = resolveDistillPaths(agentId, run.subject);
  const runPaths = resolveDistillRunPaths(paths, run.runId);
  return {
    runId: run.runId,
    status: deriveRunStatus(run),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    stages: run.stages,
    stats: run.stats,
    sources: run.sources,
    reportPath: runPaths.reportPath,
    packetMarkdownPath: runPaths.packetMarkdownPath,
    extractionPath: runPaths.extractionPath,
    artifacts: {
      report: readEmbeddedTextFile(runPaths.reportPath),
      packetMarkdown: readEmbeddedTextFile(runPaths.packetMarkdownPath),
      extraction: readEmbeddedTextFile(runPaths.extractionPath),
    },
  };
}

function deriveRunStatus(run) {
  const states = DISTILL_STAGE_ORDER.map((stage) => run.stages[stage]?.status);
  if (states.includes('failed')) return 'failed';
  if (states.includes('awaiting-extraction')) return 'awaiting-extraction';
  if (states.every((status) => status === 'completed')) return 'completed';
  return 'pending';
}

function summarizeSubject(agentId, alias, profile) {
  const paths = resolveDistillPaths(agentId, alias);
  const corpus = listCorpusDocuments(paths);
  const runs = listDistillRuns(paths)
    .slice()
    .reverse()
    .map((run) => summarizeRun(agentId, run));
  return {
    agentId,
    alias,
    registeredAgent: getAgentById(agentId) !== null,
    profile,
    consent: summarizeConsent(loadConsentArtefact(paths)),
    paths: {
      workspacePath: paths.workspaceDir,
      subjectPath: paths.subjectDir,
      uploadsPath: path.join(paths.subjectDir, 'uploads'),
      corpusDocumentsPath: paths.corpusDocumentsPath,
    },
    corpusDocuments: corpus.length,
    corpus: corpus.map(summarizeCorpusDocument),
    openReviews: listReviewItems(paths).filter(
      (review) => review.status === 'open',
    ).length,
    runs,
    latestRun: runs[0] || null,
  };
}

function collectSubjectSummaries() {
  const agentsRoot = path.join(DATA_DIR, 'agents');
  let agentEntries;
  try {
    agentEntries = fs.readdirSync(agentsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const subjects = [];
  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory()) continue;
    const agentId = agentEntry.name;
    const distillRoot = path.join(agentsRoot, agentId, 'workspace', 'distill');
    let subjectEntries;
    try {
      subjectEntries = fs.readdirSync(distillRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const subjectEntry of subjectEntries) {
      if (!subjectEntry.isDirectory()) continue;
      const alias = subjectEntry.name;
      const paths = resolveDistillPaths(agentId, alias);
      const profile = loadSubjectProfile(paths);
      if (!profile) continue;
      subjects.push(summarizeSubject(agentId, alias, profile));
    }
  }
  return subjects.sort((left, right) => {
    const leftUpdated = left.latestRun?.updatedAt || '';
    const rightUpdated = right.latestRun?.updatedAt || '';
    return (
      rightUpdated.localeCompare(leftUpdated) ||
      left.profile.displayName.localeCompare(right.profile.displayName)
    );
  });
}

function getGatewayAdminDistill() {
  return {
    sourceKinds: DISTILL_SOURCE_KINDS,
    subjects: collectSubjectSummaries(),
  };
}

function upsertGatewayAdminDistillSubject(input) {
  const alias = normalizeAlias(input.alias);
  const agentId = normalizeAgentId(input.agentId, alias);
  const paths = resolveDistillPaths(agentId, alias);
  const { profile } = ensureSubjectProfile(paths, {
    alias,
    displayName: normalizeOptionalText(input.displayName),
    realPerson:
      typeof input.realPerson === 'boolean' ? input.realPerson : undefined,
    role: normalizeOptionalText(input.role),
    relationship: normalizeOptionalText(input.relationship),
    personalityTags: normalizeTextArray(input.personalityTags),
    matchAliases: normalizeTextArray(input.matchAliases),
  });
  return summarizeSubject(agentId, alias, profile);
}

function recordGatewayAdminDistillConsent(input) {
  const alias = normalizeAlias(input.alias);
  const agentId = normalizeAgentId(input.agentId, alias);
  const paths = resolveDistillPaths(agentId, alias);
  const profile = requireAdminSubjectProfile(paths);
  try {
    recordConsentArtefact(paths, {
      subjectName:
        normalizeOptionalText(input.subjectName) || profile.displayName,
      grantedBy: normalizeOptionalText(input.grantedBy) || '',
      method: normalizeOptionalText(input.method) || '',
      statement: normalizeOptionalText(input.statement) || '',
      scope: normalizeOptionalText(input.scope),
      note: normalizeOptionalText(input.note),
    });
  } catch (error) {
    throw new WebhookHttpError(
      400,
      error instanceof Error ? error.message : String(error),
    );
  }
  return summarizeSubject(agentId, alias, profile);
}

function normalizeRunSources(input) {
  const defaultKind = normalizeSourceKind(input.kind);
  if (!Array.isArray(input.sources)) return [];
  const sources = [];
  for (const source of input.sources) {
    if (typeof source === 'string') {
      const sourcePath = source.trim();
      if (sourcePath) sources.push({ path: sourcePath, kind: defaultKind });
      continue;
    }
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      continue;
    }
    const record = source;
    const sourcePath = normalizeOptionalText(record.path);
    if (!sourcePath) continue;
    sources.push({
      path: sourcePath,
      kind: normalizeSourceKind(record.kind),
    });
  }
  return sources;
}

function runGatewayAdminDistillPipeline(input) {
  const alias = normalizeAlias(input.alias);
  const agentId = normalizeAgentId(input.agentId, alias);
  const paths = resolveDistillPaths(agentId, alias);
  const resumeRunId = normalizeOptionalText(input.resumeRunId);
  const profile = resumeRunId
    ? requireAdminSubjectProfile(paths)
    : ensureSubjectProfile(paths, {
        alias,
        displayName: normalizeOptionalText(input.displayName),
        realPerson:
          typeof input.realPerson === 'boolean' ? input.realPerson : undefined,
        role: normalizeOptionalText(input.role),
        relationship: normalizeOptionalText(input.relationship),
        personalityTags: normalizeTextArray(input.personalityTags),
        matchAliases: normalizeTextArray(input.matchAliases),
      }).profile;
  const sources = normalizeRunSources(input);
  if (!resumeRunId && sources.length === 0) {
    throw new WebhookHttpError(
      400,
      'Provide at least one source or a run id to resume.',
    );
  }
  let result;
  try {
    result = runDistillPipeline(paths, profile, {
      sources,
      resumeRunId,
      holdoutRatio: normalizeHoldoutRatio(input.holdoutRatio),
    });
  } catch (error) {
    if (error instanceof DistillBlockedError) {
      throw new WebhookHttpError(
        409,
        `${error.message}\n\n${error.remediation}`,
      );
    }
    throw error;
  }
  return {
    subject: summarizeSubject(agentId, alias, profile),
    run: summarizeRun(agentId, result.run),
    warnings: result.warnings,
    flagged: result.flagged,
  };
}

function registerGatewayAdminDistillAgent(input) {
  const alias = normalizeAlias(input.alias);
  const agentId = normalizeAgentId(input.agentId, alias);
  const paths = resolveDistillPaths(agentId, alias);
  const profile = requireAdminSubjectProfile(paths);
  if (!getAgentById(agentId)) {
    const saved = upsertRegisteredAgent({
      id: agentId,
      name: profile.displayName,
      ...(profile.role ? { role: profile.role } : {}),
    });
    ensureBootstrapFiles(saved.id);
  }
  ensureDistilledMemoryFile(paths, profile);
  return summarizeSubject(agentId, alias, profile);
}

function requireGatewayAdminDistillCorpusDocument(input) {
  const alias = normalizeAlias(input.alias);
  const agentId = normalizeAgentId(input.agentId, alias);
  const paths = resolveDistillPaths(agentId, alias);
  const profile = requireAdminSubjectProfile(paths);
  const documentId = normalizeCorpusDocumentId(input.documentId);
  const document = getCorpusDocument(paths, documentId);
  if (!document) {
    throw new WebhookHttpError(404, 'Corpus document not found.');
  }
  return { agentId, alias, paths, profile, documentId, document };
}

function corpusDocumentDownloadFilename(document) {
  const label = document.title || document.source;
  return sanitizeDistillUploadFilename(`${document.id}-${label}.txt`);
}

function getGatewayAdminDistillCorpusDocument(input) {
  const { document, documentId } =
    requireGatewayAdminDistillCorpusDocument(input);
  return {
    documentId,
    filename: corpusDocumentDownloadFilename(document),
    content: document.content,
  };
}

function deleteGatewayAdminDistillCorpusDocument(input) {
  const { agentId, alias, paths, profile, documentId } =
    requireGatewayAdminDistillCorpusDocument(input);
  removeCorpusDocument(paths, documentId);
  return summarizeSubject(agentId, alias, profile);
}

function sanitizeDistillUploadFilename(raw) {
  const basename = path.basename(raw.trim() || 'source.txt');
  const safe = basename
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return safe || 'source.txt';
}

async function uploadGatewayAdminDistillSource(params) {
  const alias = normalizeAlias(params.alias);
  const agentId = normalizeAgentId(params.agentId, alias);
  const paths = resolveDistillPaths(agentId, alias);
  requireAdminSubjectProfile(paths);
  if (params.buffer.length === 0) {
    throw new WebhookHttpError(400, 'Uploaded source file is empty.');
  }
  const filename = sanitizeDistillUploadFilename(params.filename);
  const datePrefix = new Date().toISOString().slice(0, 10);
  const storedFilename = `${Date.now()}-${randomUUID().slice(0, 8)}-${filename}`;
  const uploadDir = path.join(paths.subjectDir, 'uploads', datePrefix);
  const filePath = path.join(uploadDir, storedFilename);
  fs.mkdirSync(uploadDir, { recursive: true });
  await fs.promises.writeFile(filePath, params.buffer, { mode: 0o600 });
  return {
    path: filePath,
    filename,
    sizeBytes: params.buffer.length,
    preview: embeddedTextFromBuffer(
      params.buffer,
      ADMIN_DISTILL_UPLOAD_PREVIEW_BYTES,
    ),
    source: {
      path: filePath,
      kind: normalizeSourceKind(params.kind),
    },
  };
}

const MAX_JSON_BODY_BYTES = 1_000_000;
const MAX_SOURCE_UPLOAD_BYTES = 20 * 1024 * 1024;

function readJsonObject(req) {
  return readWebhookJsonBody(req, {
    maxBytes: MAX_JSON_BODY_BYTES,
    tooLargeMessage: 'Request body too large.',
    invalidJsonMessage: 'Invalid JSON body',
    requireObject: true,
    invalidShapeMessage: 'Request body must be a JSON object.',
  });
}

async function readUploadBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_SOURCE_UPLOAD_BYTES) {
      throw new WebhookHttpError(413, 'Request body too large.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function decodeUploadFilename(req) {
  const header = req.headers['x-hybridclaw-filename'];
  const encoded = (Array.isArray(header) ? header[0] : header)?.trim();
  if (!encoded) {
    throw new WebhookHttpError(400, 'Missing `X-Hybridclaw-Filename` header.');
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new WebhookHttpError(400, 'Invalid `X-Hybridclaw-Filename` header.');
  }
}

function subjectQuery(url) {
  return {
    agentId: url.searchParams.get('agentId') || undefined,
    alias: url.searchParams.get('alias') || undefined,
  };
}

/** Registers the admin console API; the gateway enforces each rbacAction. */
export function registerDistillAdminRoutes(api) {
  const route = (method, suffix, rbacAction, handler) =>
    api.registerAdminRoute({
      method,
      path: `/api/admin/distill${suffix}`,
      rbacAction,
      handler,
    });

  route('GET', '', 'admin.distill.read', ({ res }) => {
    sendWebhookJson(res, 200, getGatewayAdminDistill());
  });
  route('POST', '/subjects', 'admin.distill.write', async ({ req, res }) => {
    const body = await readJsonObject(req);
    sendWebhookJson(res, 201, {
      subject: upsertGatewayAdminDistillSubject(body),
    });
  });
  route('POST', '/consent', 'admin.distill.write', async ({ req, res }) => {
    const body = await readJsonObject(req);
    sendWebhookJson(res, 201, {
      subject: recordGatewayAdminDistillConsent(body),
    });
  });
  route('POST', '/register', 'admin.distill.write', async ({ req, res }) => {
    const body = await readJsonObject(req);
    sendWebhookJson(res, 201, {
      subject: registerGatewayAdminDistillAgent(body),
    });
  });
  route('POST', '/runs', 'admin.distill.write', async ({ req, res }) => {
    const body = await readJsonObject(req);
    sendWebhookJson(res, 200, runGatewayAdminDistillPipeline(body));
  });
  route(
    'POST',
    '/sources/upload',
    'admin.distill.write',
    async ({ req, res, url }) => {
      const filename = decodeUploadFilename(req);
      const buffer = await readUploadBody(req);
      sendWebhookJson(
        res,
        201,
        await uploadGatewayAdminDistillSource({
          ...subjectQuery(url),
          kind: url.searchParams.get('kind') || undefined,
          filename,
          buffer,
        }),
      );
    },
  );
  route(
    'GET',
    '/corpus/:documentId',
    'admin.distill.read',
    ({ res, url, params }) => {
      const download = getGatewayAdminDistillCorpusDocument({
        ...subjectQuery(url),
        documentId: params.documentId,
      });
      const body = Buffer.from(download.content, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${download.filename.replace(/"/g, '')}"`,
        'Cache-Control': 'no-store',
        'Content-Length': String(body.length),
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(body);
    },
  );
  route(
    'DELETE',
    '/corpus/:documentId',
    'admin.distill.delete',
    ({ res, url, params }) => {
      sendWebhookJson(res, 200, {
        subject: deleteGatewayAdminDistillCorpusDocument({
          ...subjectQuery(url),
          documentId: params.documentId,
        }),
      });
    },
  );
}
