import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  getAgentById,
  upsertRegisteredAgent,
} from '../agents/agent-registry.js';
import { DATA_DIR } from '../config/config.js';
import {
  loadConsentArtefact,
  recordConsentArtefact,
} from '../distill/consent.js';
import { listCorpusDocuments } from '../distill/corpus.js';
import {
  ensureDistilledMemoryFile,
  listReviewItems,
} from '../distill/merge.js';
import {
  type DistillPaths,
  normalizeSubjectAlias,
  resolveDistillPaths,
  resolveDistillRunPaths,
} from '../distill/paths.js';
import { runDistillPipeline } from '../distill/pipeline.js';
import { listDistillRuns } from '../distill/run.js';
import {
  ensureSubjectProfile,
  loadSubjectProfile,
  requireSubjectProfile,
} from '../distill/subject.js';
import type {
  ConsentArtefact,
  CorpusDocument,
  DistillRunRecord,
  DistillRunSource,
  DistillStageName,
  DistillStageState,
  SubjectProfile,
} from '../distill/types.js';
import { DISTILL_STAGE_ORDER, DistillBlockedError } from '../distill/types.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { ensureBootstrapFiles } from '../workspace.js';

export const ADMIN_DISTILL_SOURCE_KINDS = [
  'auto',
  'slack-export',
  'email-mbox',
  'transcript',
  'chat-jsonl',
  'markdown',
  'text',
  'interview',
] as const;

type AdminDistillSelectableSourceKind =
  (typeof ADMIN_DISTILL_SOURCE_KINDS)[number];
type AdminDistillSourceKind = DistillRunSource['kind'];
const ADMIN_DISTILL_FILE_PREVIEW_BYTES = 80_000;
const ADMIN_DISTILL_UPLOAD_PREVIEW_BYTES = 40_000;
const ADMIN_DISTILL_CORPUS_PREVIEW_CHARS = 2_000;

export interface GatewayAdminDistillConsentSummary {
  present: boolean;
  valid: boolean;
  revokedAt: string | null;
  recordedAt: string | null;
  grantedBy: string | null;
  method: string | null;
  scope: string | null;
  sha256: string | null;
}

export interface GatewayAdminDistillEmbeddedText {
  available: boolean;
  content: string;
  byteLength: number;
  truncated: boolean;
  error: string | null;
}

export interface GatewayAdminDistillRunSummary {
  runId: string;
  status: 'pending' | 'awaiting-extraction' | 'failed' | 'completed';
  createdAt: string;
  updatedAt: string;
  stages: Record<DistillStageName, DistillStageState>;
  stats: DistillRunRecord['stats'];
  sources: DistillRunSource[];
  reportPath: string;
  packetMarkdownPath: string;
  extractionPath: string;
  artifacts: {
    report: GatewayAdminDistillEmbeddedText;
    packetMarkdown: GatewayAdminDistillEmbeddedText;
    extraction: GatewayAdminDistillEmbeddedText;
  };
}

export interface GatewayAdminDistillDataPaths {
  workspacePath: string;
  subjectPath: string;
  uploadsPath: string;
  corpusDocumentsPath: string;
}

export interface GatewayAdminDistillCorpusDocumentSummary {
  id: string;
  source: CorpusDocument['source'];
  origin: string;
  author: string;
  authoredBySubject: boolean;
  title?: string;
  channel?: string;
  timestamp?: string;
  wordCount: number;
  weight: number;
  holdout: boolean;
  runId: string | null;
  contentPreview: GatewayAdminDistillEmbeddedText;
}

export interface GatewayAdminDistillSubjectSummary {
  agentId: string;
  alias: string;
  registeredAgent: boolean;
  profile: SubjectProfile;
  consent: GatewayAdminDistillConsentSummary;
  paths: GatewayAdminDistillDataPaths;
  corpusDocuments: number;
  corpus: GatewayAdminDistillCorpusDocumentSummary[];
  openReviews: number;
  runs: GatewayAdminDistillRunSummary[];
  latestRun: GatewayAdminDistillRunSummary | null;
}

export interface GatewayAdminDistillResponse {
  sourceKinds: readonly AdminDistillSelectableSourceKind[];
  subjects: GatewayAdminDistillSubjectSummary[];
}

export interface GatewayAdminDistillSubjectInput {
  agentId?: unknown;
  alias?: unknown;
  displayName?: unknown;
  realPerson?: unknown;
  role?: unknown;
  relationship?: unknown;
  personalityTags?: unknown;
  matchAliases?: unknown;
}

export interface GatewayAdminDistillConsentInput {
  agentId?: unknown;
  alias?: unknown;
  subjectName?: unknown;
  grantedBy?: unknown;
  method?: unknown;
  statement?: unknown;
  scope?: unknown;
  note?: unknown;
}

export interface GatewayAdminDistillRunInput
  extends GatewayAdminDistillSubjectInput {
  sources?: unknown;
  resumeRunId?: unknown;
  holdoutRatio?: unknown;
  kind?: unknown;
}

export interface GatewayAdminDistillRegisterInput {
  agentId?: unknown;
  alias?: unknown;
}

export interface GatewayAdminDistillUploadResult {
  source: DistillRunSource;
  path: string;
  filename: string;
  sizeBytes: number;
  preview: GatewayAdminDistillEmbeddedText;
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeTextArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function normalizeAgentId(value: unknown, fallback: string): string {
  return normalizeOptionalText(value) || fallback;
}

function normalizeSourceKind(value: unknown): AdminDistillSourceKind {
  const raw = normalizeOptionalText(value) || 'auto';
  if (
    ![...ADMIN_DISTILL_SOURCE_KINDS, 'correction'].includes(
      raw as AdminDistillSourceKind,
    )
  ) {
    throw new GatewayRequestError(400, `Unsupported source kind: ${raw}.`);
  }
  return raw as AdminDistillSourceKind;
}

function normalizeAlias(value: unknown): string {
  const raw = normalizeOptionalText(value);
  if (!raw) {
    throw new GatewayRequestError(400, '`alias` is required.');
  }
  try {
    return normalizeSubjectAlias(raw);
  } catch (error) {
    throw new GatewayRequestError(
      400,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function normalizeHoldoutRatio(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const ratio = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 0.5) {
    throw new GatewayRequestError(
      400,
      '`holdoutRatio` must be a number between 0 and 0.5.',
    );
  }
  return ratio;
}

function requireAdminSubjectProfile(paths: DistillPaths) {
  try {
    return requireSubjectProfile(paths);
  } catch (error) {
    throw new GatewayRequestError(
      404,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function consentDigest(consent: ConsentArtefact): string {
  return createHash('sha256')
    .update(
      [
        consent.subject,
        consent.subjectName,
        consent.grantedBy,
        consent.method,
        consent.scope,
        consent.statement,
        consent.recordedAt,
      ].join('\n'),
      'utf-8',
    )
    .digest('hex');
}

function summarizeConsent(
  consent: ConsentArtefact | null,
): GatewayAdminDistillConsentSummary {
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

function embeddedTextFromString(
  content: string,
  maxChars: number,
): GatewayAdminDistillEmbeddedText {
  const truncated = content.length > maxChars;
  return {
    available: true,
    content: truncated ? content.slice(0, maxChars) : content,
    byteLength: Buffer.byteLength(content, 'utf-8'),
    truncated,
    error: null,
  };
}

function embeddedTextFromBuffer(
  buffer: Buffer,
  maxBytes: number,
): GatewayAdminDistillEmbeddedText {
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

function readEmbeddedTextFile(
  filePath: string,
): GatewayAdminDistillEmbeddedText {
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
    const err = error as NodeJS.ErrnoException;
    return {
      available: false,
      content: '',
      byteLength: 0,
      truncated: false,
      error:
        err.code === 'ENOENT'
          ? 'Not generated yet.'
          : err.message || 'Unable to read artifact.',
    };
  }
}

function summarizeCorpusDocument(
  document: CorpusDocument,
): GatewayAdminDistillCorpusDocumentSummary {
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

function summarizeRun(
  agentId: string,
  run: DistillRunRecord,
): GatewayAdminDistillRunSummary {
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

function deriveRunStatus(
  run: DistillRunRecord,
): GatewayAdminDistillRunSummary['status'] {
  const states = DISTILL_STAGE_ORDER.map((stage) => run.stages[stage]?.status);
  if (states.includes('failed')) return 'failed';
  if (states.includes('awaiting-extraction')) return 'awaiting-extraction';
  if (states.every((status) => status === 'completed')) return 'completed';
  return 'pending';
}

function summarizeSubject(
  agentId: string,
  alias: string,
  profile: SubjectProfile,
): GatewayAdminDistillSubjectSummary {
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

function collectSubjectSummaries(): GatewayAdminDistillSubjectSummary[] {
  const agentsRoot = path.join(DATA_DIR, 'agents');
  let agentEntries: fs.Dirent[];
  try {
    agentEntries = fs.readdirSync(agentsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const subjects: GatewayAdminDistillSubjectSummary[] = [];
  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory()) continue;
    const agentId = agentEntry.name;
    const distillRoot = path.join(agentsRoot, agentId, 'workspace', 'distill');
    let subjectEntries: fs.Dirent[];
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

export function getGatewayAdminDistill(): GatewayAdminDistillResponse {
  return {
    sourceKinds: ADMIN_DISTILL_SOURCE_KINDS,
    subjects: collectSubjectSummaries(),
  };
}

export function upsertGatewayAdminDistillSubject(
  input: GatewayAdminDistillSubjectInput,
): GatewayAdminDistillSubjectSummary {
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

export function recordGatewayAdminDistillConsent(
  input: GatewayAdminDistillConsentInput,
): GatewayAdminDistillSubjectSummary {
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
    throw new GatewayRequestError(
      400,
      error instanceof Error ? error.message : String(error),
    );
  }
  return summarizeSubject(agentId, alias, profile);
}

function normalizeRunSources(
  input: GatewayAdminDistillRunInput,
): DistillRunSource[] {
  const defaultKind = normalizeSourceKind(input.kind);
  if (!Array.isArray(input.sources)) return [];
  const sources: DistillRunSource[] = [];
  for (const source of input.sources) {
    if (typeof source === 'string') {
      const sourcePath = source.trim();
      if (sourcePath) sources.push({ path: sourcePath, kind: defaultKind });
      continue;
    }
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      continue;
    }
    const record = source as { path?: unknown; kind?: unknown };
    const sourcePath = normalizeOptionalText(record.path);
    if (!sourcePath) continue;
    sources.push({
      path: sourcePath,
      kind: normalizeSourceKind(record.kind),
    });
  }
  return sources;
}

export function runGatewayAdminDistillPipeline(
  input: GatewayAdminDistillRunInput,
): {
  subject: GatewayAdminDistillSubjectSummary;
  run: GatewayAdminDistillRunSummary;
  warnings: string[];
  flagged: string[];
} {
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
    throw new GatewayRequestError(
      400,
      'Provide at least one source or a run id to resume.',
    );
  }
  let result: ReturnType<typeof runDistillPipeline>;
  try {
    result = runDistillPipeline(paths, profile, {
      sources,
      resumeRunId,
      holdoutRatio: normalizeHoldoutRatio(input.holdoutRatio),
    });
  } catch (error) {
    if (error instanceof DistillBlockedError) {
      throw new GatewayRequestError(
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

export function registerGatewayAdminDistillAgent(
  input: GatewayAdminDistillRegisterInput,
): GatewayAdminDistillSubjectSummary {
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

function sanitizeDistillUploadFilename(raw: string): string {
  const basename = path.basename(raw.trim() || 'source.txt');
  const safe = basename
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return safe || 'source.txt';
}

export async function uploadGatewayAdminDistillSource(params: {
  agentId?: unknown;
  alias?: unknown;
  filename: string;
  buffer: Buffer;
  kind?: unknown;
}): Promise<GatewayAdminDistillUploadResult> {
  const alias = normalizeAlias(params.alias);
  const agentId = normalizeAgentId(params.agentId, alias);
  const paths = resolveDistillPaths(agentId, alias);
  requireAdminSubjectProfile(paths);
  if (params.buffer.length === 0) {
    throw new GatewayRequestError(400, 'Uploaded source file is empty.');
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
