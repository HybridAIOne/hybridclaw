import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJsonObject, truncateAuditText } from '../audit/audit-trail.js';
import { APP_VERSION } from '../config/config.js';
import { agentWorkspaceDir, ensureAgentDirs } from '../infra/ipc.js';
import { logger } from '../logger.js';
import { formatModelForDisplay } from '../providers/model-names.js';
import { redactHighEntropyStrings, redactSecrets } from '../security/redact.js';
import type { StructuredAuditEntry } from '../types/audit.js';
import type { Session, StoredMessage } from '../types/session.js';
import type { UsageTotals } from '../types/usage.js';

const TRACE_EXPORTS_DIR_NAME = '.trace-exports';
const OPENTRACES_SCHEMA_VERSION = '0.1.0';
const ATIF_COMPAT_VERSION = '1.6';
const TRACE_USERNAME_HASH_LENGTH = 8;
const TRACE_SYSTEM_PROMPT_HASH_LENGTH = 16;
const MAX_TRACE_VCS_DIFF_CHARS = 250_000;
const TRACE_PRESERVED_IDENTIFIER_KEYS = new Set([
  'session_id',
  'trace_id',
  'tool_call_id',
  'source_call_id',
]);
const TRACE_SYSTEM_USERNAMES = new Set([
  'Shared',
  'lib',
  'admin',
  'root',
  'default',
  'Public',
  'Guest',
]);
const TRACE_SLASH_USERNAME_PATH_RE =
  /(?:\/Users\/|\/home\/|[A-Za-z]:\/Users\/|\/mnt\/[A-Za-z]\/Users\/|\/\/wsl\.localhost\/[^/]+\/home\/)([A-Za-z0-9][A-Za-z0-9_-]{2,})\//g;
const TRACE_BACKSLASH_USERNAME_PATH_RE =
  /(?:[A-Za-z]:\\Users\\|\\\\wsl\.localhost\\[^\\]+\\home\\)([A-Za-z0-9][A-Za-z0-9_-]{2,})\\/g;
const TRACE_SLASH_USERNAME_PATH_PREFIX_RE =
  /((?:\/Users\/|\/home\/|[A-Za-z]:\/Users\/|\/mnt\/[A-Za-z]\/Users\/|\/\/wsl\.localhost\/[^/]+\/home\/))([^/\s]+)(\/)/g;
const TRACE_BACKSLASH_USERNAME_PATH_PREFIX_RE =
  /((?:[A-Za-z]:\\Users\\|\\\\wsl\.localhost\\[^\\]+\\home\\))([^\\\s]+)(\\)/g;

const TRACE_EXPORT_EXTRA_REDACTION_PATTERNS: ReadonlyArray<{
  match: RegExp;
  replace: string;
}> = Object.freeze([
  {
    match: /\b(pypi-[A-Za-z0-9_-]{20,})\b/g,
    replace: '***PYPI_TOKEN_REDACTED***',
  },
  {
    match: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]{8,}\.[A-Za-z0-9._-]{8,}\b/g,
    replace: '***JWT_REDACTED***',
  },
  {
    match: /\bhttps:\/\/discord(?:app)?\.com\/api\/webhooks\/[^\s"'`]+/gi,
    replace: '***DISCORD_WEBHOOK_REDACTED***',
  },
]);
const TRACE_EXPORT_BASE_LIMITATIONS = Object.freeze([
  'Tool observations use structured audit summaries because full tool stdout/stderr is not retained in the audit trail.',
  'Environment metadata fields such as os and shell are exported as runtime host information and are not anonymized.',
]);
const TRACE_EXPORT_FALLBACK_LIMITATION =
  'Structured turn audit was unavailable, so steps were reconstructed directly from stored session messages.';
const TRACE_DEPENDENCY_MANIFEST_FILES = [
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'Gemfile',
  'go.mod',
] as const;

interface TurnGroup {
  runId: string;
  rows: StructuredAuditEntry[];
  turnStart: StructuredAuditEntry;
}

interface ToolResultSummary {
  durationMs: number | null;
  content: string | null;
  isError: boolean | null;
}

interface TurnRowSummary {
  agentStart: StructuredAuditEntry | null;
  usageRow: StructuredAuditEntry | null;
  turnEnd: StructuredAuditEntry | null;
  errorRow: StructuredAuditEntry | null;
  toolCallRows: StructuredAuditEntry[];
  toolResultRows: StructuredAuditEntry[];
}

interface TraceProjectContext {
  workspaceRoot: string;
  repoRoot: string | null;
  repository: string | null;
  baseCommit: string | null;
  branch: string | null;
  diff: string | null;
  dependencies: string[];
  languageEcosystem: string[];
}

enum TraceRedactionFieldType {
  General = 'general',
  ToolInput = 'tool_input',
  ToolResult = 'tool_result',
  Identifier = 'identifier',
}

function safeFilePart(raw: string): string {
  const normalized = raw.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  return normalized || 'session';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exportBaseDir(agentId: string, sessionId: string): string {
  ensureAgentDirs(agentId);
  return path.join(
    agentWorkspaceDir(agentId),
    TRACE_EXPORTS_DIR_NAME,
    safeFilePart(sessionId),
  );
}

function exportFilePath(baseDir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(baseDir, `${stamp}-atif-v1_6.jsonl`);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function shortContentHash(text: string): string | null {
  if (!text) return null;
  return createHash('md5').update(text).digest('hex').slice(0, 8);
}

function findNearestPackageRoot(startPath: string | undefined): string | null {
  if (!startPath) return null;

  let current: string;
  try {
    const resolved = path.resolve(startPath);
    current =
      fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
        ? resolved
        : path.dirname(resolved);
  } catch {
    return null;
  }

  for (;;) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function findNearestDependencyRoot(
  startPath: string | undefined,
): string | null {
  if (!startPath) return null;

  let current: string;
  try {
    const resolved = path.resolve(startPath);
    current =
      fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
        ? resolved
        : path.dirname(resolved);
  } catch {
    return null;
  }

  for (;;) {
    if (
      TRACE_DEPENDENCY_MANIFEST_FILES.some((fileName) =>
        fs.existsSync(path.join(current, fileName)),
      )
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function findNearestGitRoot(startPath: string | undefined): string | null {
  if (!startPath) return null;

  let current: string;
  try {
    const resolved = path.resolve(startPath);
    current =
      fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
        ? resolved
        : path.dirname(resolved);
  } catch {
    return null;
  }

  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveGitDir(repoRoot: string): string | null {
  const dotGitPath = path.join(repoRoot, '.git');
  try {
    const stat = fs.statSync(dotGitPath);
    if (stat.isDirectory()) return dotGitPath;
    const content = fs.readFileSync(dotGitPath, 'utf-8').trim();
    const match = /^gitdir:\s*(.+)$/im.exec(content);
    if (!match?.[1]) return null;
    return path.resolve(repoRoot, match[1].trim());
  } catch {
    return null;
  }
}

function normalizeRepositoryValue(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) return null;
  const shorthand = /^(?:github:)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/i.exec(
    normalized,
  );
  if (shorthand?.[1]) return shorthand[1];

  const scpLike =
    /^(?:git@)?[^:/]+:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(
      normalized,
    );
  if (scpLike) return `${scpLike[1]}/${scpLike[2]}`;

  try {
    const withScheme = normalized.includes('://')
      ? normalized
      : `https://${normalized}`;
    const parsed = new URL(withScheme);
    const segments = parsed.pathname
      .replace(/\.git$/i, '')
      .split('/')
      .filter(Boolean);
    if (segments.length >= 2) return `${segments[0]}/${segments[1]}`;
  } catch {}

  return null;
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readPackageDependencies(packageRoot: string): string[] {
  const parsed = readJsonRecord(path.join(packageRoot, 'package.json'));
  if (!parsed) return [];
  const names = new Set<string>();
  for (const key of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const bucket = parsed[key];
    if (!isRecord(bucket)) continue;
    for (const name of Object.keys(bucket)) {
      const normalized = name.trim();
      if (normalized) names.add(normalized);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function readRequirementsDependencies(projectRoot: string): string[] {
  try {
    return fs
      .readFileSync(path.join(projectRoot, 'requirements.txt'), 'utf-8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && !line.startsWith('-'))
      .map((line) => line.split(/[><=!~;@[]/, 1)[0]?.trim() || '')
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readPyprojectDependencies(projectRoot: string): string[] {
  try {
    const content = fs.readFileSync(
      path.join(projectRoot, 'pyproject.toml'),
      'utf-8',
    );
    const names: string[] = [];
    let inDependencies = false;
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === 'dependencies = [') {
        inDependencies = true;
        continue;
      }
      if (!inDependencies) continue;
      if (line === ']') break;
      const entry = line.replace(/^["']|["'],?$/g, '').trim();
      if (!entry) continue;
      const name = entry.split(/[><=!~;[\s]/, 1)[0]?.trim();
      if (name) names.push(name);
    }
    return names;
  } catch {
    return [];
  }
}

function readGemfileDependencies(projectRoot: string): string[] {
  try {
    const content = fs.readFileSync(path.join(projectRoot, 'Gemfile'), 'utf-8');
    return [...content.matchAll(/gem\s+['"]([^'"]+)['"]/g)]
      .map((match) => match[1]?.trim() || '')
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readGoModDependencies(projectRoot: string): string[] {
  try {
    const content = fs.readFileSync(path.join(projectRoot, 'go.mod'), 'utf-8');
    const names: string[] = [];
    let inRequireBlock = false;
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith('require (')) {
        inRequireBlock = true;
        continue;
      }
      if (inRequireBlock && line === ')') {
        inRequireBlock = false;
        continue;
      }
      if (inRequireBlock) {
        const name = line.split(/\s+/, 1)[0]?.trim();
        if (name) names.push(name);
        continue;
      }
      if (!line.startsWith('require ')) continue;
      const parts = line.split(/\s+/);
      if (parts[1]) names.push(parts[1]);
    }
    return names;
  } catch {
    return [];
  }
}

function readProjectDependencies(projectRoot: string): string[] {
  const names = new Set<string>();
  for (const dependency of readPackageDependencies(projectRoot)) {
    names.add(dependency);
  }
  for (const dependency of readRequirementsDependencies(projectRoot)) {
    names.add(dependency);
  }
  for (const dependency of readPyprojectDependencies(projectRoot)) {
    names.add(dependency);
  }
  for (const dependency of readGemfileDependencies(projectRoot)) {
    names.add(dependency);
  }
  for (const dependency of readGoModDependencies(projectRoot)) {
    names.add(dependency);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function readPackageRepository(packageRoot: string): string | null {
  const parsed = readJsonRecord(path.join(packageRoot, 'package.json'));
  if (!parsed) return null;
  const repository = parsed.repository;
  if (typeof repository === 'string') {
    return normalizeRepositoryValue(repository);
  }
  if (isRecord(repository) && typeof repository.url === 'string') {
    return normalizeRepositoryValue(repository.url);
  }
  return null;
}

function readGitRemoteRepository(repoRoot: string): string | null {
  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir) return null;
  try {
    const config = fs.readFileSync(path.join(gitDir, 'config'), 'utf-8');
    const remoteMatch =
      /\[remote "origin"\][\s\S]*?(?:^\s*url\s*=\s*(.+)\s*$)/m.exec(config);
    return remoteMatch?.[1] ? normalizeRepositoryValue(remoteMatch[1]) : null;
  } catch {
    return null;
  }
}

function readGitBaseCommit(repoRoot: string): string | null {
  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir) return null;
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
    if (/^[a-f0-9]{40}$/i.test(head)) return head.toLowerCase();
    const refMatch = /^ref:\s*(.+)$/i.exec(head);
    if (!refMatch?.[1]) return null;
    const refPath = path.join(gitDir, refMatch[1].trim());
    if (fs.existsSync(refPath)) {
      const ref = fs.readFileSync(refPath, 'utf-8').trim();
      return /^[a-f0-9]{40}$/i.test(ref) ? ref.toLowerCase() : null;
    }
  } catch {}
  return null;
}

function readGitBranch(repoRoot: string): string | null {
  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir) return null;
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
    const refMatch = /^ref:\s*(.+)$/i.exec(head);
    if (!refMatch?.[1]) return null;
    return path.basename(refMatch[1].trim()) || null;
  } catch {
    return null;
  }
}

function truncateGitDiff(diff: string): string {
  if (diff.length <= MAX_TRACE_VCS_DIFF_CHARS) return diff;
  const omitted = diff.length - MAX_TRACE_VCS_DIFF_CHARS;
  const suffix = `\n\n[TRUNCATED hybridclaw.vcs.diff omitted_chars=${omitted}]`;
  const keep = Math.max(0, MAX_TRACE_VCS_DIFF_CHARS - suffix.length);
  return `${diff.slice(0, keep)}${suffix}`;
}

function readGitDiff(repoRoot: string): string | null {
  const result = spawnSync('git', ['diff', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  const diff = result.stdout.trim();
  return diff ? truncateGitDiff(diff) : null;
}

function extractToolFilePath(argumentsValue: unknown): string | null {
  if (!isRecord(argumentsValue)) return null;
  const pathValue = argumentsValue.path ?? argumentsValue.file_path;
  if (typeof pathValue !== 'string') return null;
  const normalized = pathValue.trim().replace(/\\/g, '/');
  return normalized || null;
}

function normalizeAttributionPath(
  rawPath: string,
  repoRoot: string | null,
  workspaceRoot: string,
): string {
  const normalizedPath = rawPath.replace(/\\/g, '/');
  const candidates = [repoRoot, workspaceRoot].filter(
    (value): value is string =>
      typeof value === 'string' && value.trim() !== '',
  );
  for (const baseDir of candidates) {
    const normalizedBase = baseDir.replace(/\\/g, '/').replace(/\/+$/, '');
    if (
      normalizedPath === normalizedBase ||
      normalizedPath.startsWith(`${normalizedBase}/`)
    ) {
      const relativePath = normalizedPath
        .slice(normalizedBase.length)
        .replace(/^\/+/, '');
      return relativePath || path.basename(normalizedPath);
    }
  }
  return normalizedPath;
}

function resolveTraceProjectContext(
  agentId: string,
  attributionPaths: Iterable<string>,
): TraceProjectContext {
  const workspaceRoot = agentWorkspaceDir(agentId);
  const dependencyRoots = new Set<string>();
  const repoRoots = new Set<string>();

  const workspacePackageRoot = findNearestPackageRoot(workspaceRoot);
  if (workspacePackageRoot) dependencyRoots.add(workspacePackageRoot);
  const workspaceDependencyRoot = findNearestDependencyRoot(workspaceRoot);
  if (workspaceDependencyRoot) dependencyRoots.add(workspaceDependencyRoot);
  const workspaceRepoRoot = findNearestGitRoot(workspaceRoot);
  if (workspaceRepoRoot) repoRoots.add(workspaceRepoRoot);

  for (const attributionPath of attributionPaths) {
    const packageRoot = findNearestPackageRoot(attributionPath);
    if (packageRoot) dependencyRoots.add(packageRoot);
    const dependencyRoot = findNearestDependencyRoot(attributionPath);
    if (dependencyRoot) dependencyRoots.add(dependencyRoot);
    const repoRoot = findNearestGitRoot(attributionPath);
    if (repoRoot) repoRoots.add(repoRoot);
  }

  const dependencies = new Set<string>();
  const languageEcosystem = new Set<string>();
  let repository: string | null = null;
  for (const dependencyRoot of dependencyRoots) {
    for (const dependency of readProjectDependencies(dependencyRoot)) {
      dependencies.add(dependency);
    }
    if (fs.existsSync(path.join(dependencyRoot, 'package.json'))) {
      languageEcosystem.add('javascript');
      repository ??= readPackageRepository(dependencyRoot);
    }
    if (
      fs.existsSync(path.join(dependencyRoot, 'requirements.txt')) ||
      fs.existsSync(path.join(dependencyRoot, 'pyproject.toml'))
    ) {
      languageEcosystem.add('python');
    }
    if (fs.existsSync(path.join(dependencyRoot, 'Gemfile'))) {
      languageEcosystem.add('ruby');
    }
    if (fs.existsSync(path.join(dependencyRoot, 'go.mod'))) {
      languageEcosystem.add('go');
    }
  }

  const repoRoot = [...repoRoots][0] || null;
  if (!repository && repoRoot) {
    repository = readGitRemoteRepository(repoRoot);
  }
  for (const attributionPath of attributionPaths) {
    const extension = path.extname(attributionPath).toLowerCase();
    if (extension === '.ts' || extension === '.tsx') {
      languageEcosystem.add('typescript');
    } else if (extension === '.js' || extension === '.jsx') {
      languageEcosystem.add('javascript');
    } else if (extension === '.py') {
      languageEcosystem.add('python');
    } else if (extension === '.rb') {
      languageEcosystem.add('ruby');
    } else if (extension === '.go') {
      languageEcosystem.add('go');
    } else if (extension === '.rs') {
      languageEcosystem.add('rust');
    }
  }

  return {
    workspaceRoot,
    repoRoot,
    repository,
    baseCommit: repoRoot ? readGitBaseCommit(repoRoot) : null,
    branch: repoRoot ? readGitBranch(repoRoot) : null,
    diff: repoRoot ? readGitDiff(repoRoot) : null,
    dependencies: [...dependencies].sort((left, right) =>
      left.localeCompare(right),
    ),
    languageEcosystem: [...languageEcosystem].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.keys(entry as Record<string, unknown>)
            .sort((left, right) => left.localeCompare(right))
            .map((key) => [key, (entry as Record<string, unknown>)[key]]),
        )
      : entry,
  );
}

function deterministicUuid(seed: string): string {
  const hex = sha256Hex(seed).slice(0, 32);
  const versionedTimeHigh = `4${hex.slice(13, 16)}`;
  const variantNibble = ((Number.parseInt(hex[16] || '0', 16) & 0x3) | 0x8)
    .toString(16)
    .toLowerCase();
  const variantClockSeq = `${variantNibble}${hex.slice(17, 20)}`;
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    versionedTimeHigh,
    variantClockSeq,
    hex.slice(20, 32),
  ].join('-');
}

function anonymizedPathUsername(username: string): string {
  return `user_${sha256Hex(username.trim().toLowerCase()).slice(0, TRACE_USERNAME_HASH_LENGTH)}`;
}

function getExplicitTraceUsernames(): string[] {
  const candidates = new Set<string>();
  for (const raw of [process.env.USER, process.env.USERNAME]) {
    const value = raw?.trim();
    if (value) candidates.add(value);
  }
  try {
    const username = os.userInfo().username.trim();
    if (username) candidates.add(username);
  } catch {}

  return [...candidates].filter(
    (username) => !TRACE_SYSTEM_USERNAMES.has(username),
  );
}

function extractTracePathUsernames(text: string): Set<string> {
  const matches = new Set<string>();
  for (const pattern of [
    TRACE_SLASH_USERNAME_PATH_RE,
    TRACE_BACKSLASH_USERNAME_PATH_RE,
  ]) {
    for (const match of text.matchAll(pattern)) {
      const username = match[1];
      if (username && !TRACE_SYSTEM_USERNAMES.has(username)) {
        matches.add(username);
      }
    }
  }
  return matches;
}

function anonymizeExplicitUsernameReferences(
  text: string,
  usernames: Iterable<string>,
): string {
  let next = text;
  for (const username of usernames) {
    const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const replacement = anonymizedPathUsername(username);
    next = next
      .replace(new RegExp(`-Users-${escaped}-`, 'g'), `-Users-${replacement}-`)
      .replace(new RegExp(`~${escaped}(?=/|$)`, 'g'), `~${replacement}`)
      .replace(new RegExp(`\\b${escaped}\\b`, 'g'), replacement);
  }
  return next;
}

function anonymizeTracePaths(text: string): string {
  let next = text
    .replace(
      TRACE_SLASH_USERNAME_PATH_PREFIX_RE,
      (_match, prefix: string, username: string, suffix: string) =>
        `${prefix}${anonymizedPathUsername(username)}${suffix}`,
    )
    .replace(
      TRACE_BACKSLASH_USERNAME_PATH_PREFIX_RE,
      (_match, prefix: string, username: string, suffix: string) =>
        `${prefix}${anonymizedPathUsername(username)}${suffix}`,
    );

  next = anonymizeExplicitUsernameReferences(next, getExplicitTraceUsernames());
  next = anonymizeExplicitUsernameReferences(
    next,
    extractTracePathUsernames(text),
  );
  return next;
}

function redactTraceText(
  text: string,
  fieldType: TraceRedactionFieldType,
): string {
  if (fieldType === TraceRedactionFieldType.Identifier) return text;
  let next = anonymizeTracePaths(text);
  next = redactSecrets(next);
  for (const pattern of TRACE_EXPORT_EXTRA_REDACTION_PATTERNS) {
    next = next.replace(pattern.match, pattern.replace);
  }
  if (
    fieldType === TraceRedactionFieldType.General ||
    fieldType === TraceRedactionFieldType.ToolInput
  ) {
    next = redactHighEntropyStrings(next);
  }
  return next;
}

function fieldTypeForChildKey(
  key: string,
  parentType: TraceRedactionFieldType,
): TraceRedactionFieldType {
  if (TRACE_PRESERVED_IDENTIFIER_KEYS.has(key)) {
    return TraceRedactionFieldType.Identifier;
  }
  if (key === 'input') return TraceRedactionFieldType.ToolInput;
  if (
    key === 'observations' ||
    key === 'output_summary' ||
    key === 'error' ||
    key === 'reasoning_content'
  ) {
    return TraceRedactionFieldType.ToolResult;
  }
  return parentType;
}

function sanitizeTraceExportValue(
  value: unknown,
  fieldType: TraceRedactionFieldType = TraceRedactionFieldType.General,
): unknown {
  if (typeof value === 'string') return redactTraceText(value, fieldType);
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeTraceExportValue(entry, fieldType));
  }
  if (!value || typeof value !== 'object') return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    sanitized[key] = sanitizeTraceExportValue(
      raw,
      fieldTypeForChildKey(key, fieldType),
    );
  }
  return sanitized;
}

function finalizeTraceRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeTraceExportValue(record) as Record<string, unknown>;
}

function readString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function readNumber(
  payload: Record<string, unknown>,
  key: string,
): number | null {
  const value = payload[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

function readBoolean(
  payload: Record<string, unknown>,
  key: string,
): boolean | null {
  const value = payload[key];
  return typeof value === 'boolean' ? value : null;
}

function truncateText(text: string, maxChars = 12_000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

function groupTurnRows(rows: StructuredAuditEntry[]): TurnGroup[] {
  const grouped = new Map<string, StructuredAuditEntry[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.run_id);
    if (bucket) {
      bucket.push(row);
      continue;
    }
    grouped.set(row.run_id, [row]);
  }

  const turns: TurnGroup[] = [];
  for (const [runId, runRows] of grouped) {
    const turnStart = runRows.find((row) => row.event_type === 'turn.start');
    if (!turnStart) continue;
    turns.push({ runId, rows: runRows, turnStart });
  }

  return turns.sort((left, right) => left.turnStart.seq - right.turnStart.seq);
}

function buildFallbackSteps(
  messages: StoredMessage[],
): Array<Record<string, unknown>> {
  return messages.map((message, index) => ({
    step_index: index,
    role: message.role === 'assistant' ? 'agent' : message.role,
    content: message.content,
    timestamp: message.created_at,
  }));
}

function buildStepTokenUsage(
  payload: Record<string, unknown> | null,
): Record<string, number> | undefined {
  if (!payload) return undefined;
  const tokenUsage: Record<string, number> = {};
  const mappings: Array<[string, string]> = [
    ['promptTokens', 'input_tokens'],
    ['completionTokens', 'output_tokens'],
    ['cacheReadTokens', 'cache_read_tokens'],
    ['cacheWriteTokens', 'cache_write_tokens'],
  ];
  for (const [sourceKey, targetKey] of mappings) {
    const value = readNumber(payload, sourceKey);
    if (value != null) tokenUsage[targetKey] = value;
  }
  return Object.keys(tokenUsage).length > 0 ? tokenUsage : undefined;
}

function summarizeTurnRows(rows: StructuredAuditEntry[]): TurnRowSummary {
  const summary: TurnRowSummary = {
    agentStart: null,
    usageRow: null,
    turnEnd: null,
    errorRow: null,
    toolCallRows: [],
    toolResultRows: [],
  };
  for (const row of rows) {
    switch (row.event_type) {
      case 'agent.start':
        summary.agentStart ??= row;
        break;
      case 'model.usage':
        summary.usageRow ??= row;
        break;
      case 'turn.end':
        summary.turnEnd ??= row;
        break;
      case 'error':
        summary.errorRow ??= row;
        break;
      case 'tool.call':
        summary.toolCallRows.push(row);
        break;
      case 'tool.result':
        summary.toolResultRows.push(row);
        break;
      default:
        break;
    }
  }
  return summary;
}

function traceSystemPromptHash(text: string): string {
  return sha256Hex(text).slice(0, TRACE_SYSTEM_PROMPT_HASH_LENGTH);
}

function buildTraceSystemPrompts(turns: TurnGroup[]): {
  systemPrompts: Record<string, string>;
  systemPromptHashByRunId: Map<string, string>;
} {
  const systemPrompts: Record<string, string> = {};
  const systemPromptHashByRunId = new Map<string, string>();
  for (const turn of turns) {
    const agentStart = summarizeTurnRows(turn.rows).agentStart;
    if (!agentStart) continue;
    const agentStartPayload = parseJsonObject(agentStart.payload);
    const systemPrompt = readString(agentStartPayload, 'systemPrompt');
    if (!systemPrompt) continue;
    const promptHash = traceSystemPromptHash(systemPrompt);
    systemPrompts[promptHash] = systemPrompt;
    systemPromptHashByRunId.set(turn.runId, promptHash);
  }
  return { systemPrompts, systemPromptHashByRunId };
}

function buildUserTraceStep(
  turn: TurnGroup,
  stepIndex: number,
): Record<string, unknown> | null {
  const turnStartPayload = parseJsonObject(turn.turnStart.payload);
  const userInput =
    readString(turnStartPayload, 'userInput') ||
    readString(turnStartPayload, 'rawUserInput');
  if (!userInput) return null;
  return {
    step_index: stepIndex,
    role: 'user',
    content: userInput,
    timestamp: turn.turnStart.timestamp,
  };
}

function buildToolResultByCallId(
  toolResultRows: StructuredAuditEntry[],
): Map<string, ToolResultSummary> {
  const resultByToolCallId = new Map<string, ToolResultSummary>();
  for (const row of toolResultRows) {
    const payload = parseJsonObject(row.payload);
    const toolCallId = readString(payload, 'toolCallId');
    if (!toolCallId) continue;
    resultByToolCallId.set(toolCallId, {
      durationMs: readNumber(payload, 'durationMs'),
      content: readString(payload, 'resultSummary'),
      isError: readBoolean(payload, 'isError'),
    });
  }
  return resultByToolCallId;
}

function buildToolCallTraceEntries(
  turn: TurnGroup,
  toolCallRows: StructuredAuditEntry[],
  resultByToolCallId: Map<string, ToolResultSummary>,
): Array<Record<string, unknown>> {
  return toolCallRows.map((row) => {
    const payload = parseJsonObject(row.payload);
    const toolCallId =
      readString(payload, 'toolCallId') || `${turn.runId}:tool`;
    const result = resultByToolCallId.get(toolCallId);
    return {
      tool_call_id: toolCallId,
      tool_name: readString(payload, 'toolName') || 'unknown',
      input: payload.arguments ?? {},
      ...(result?.durationMs != null ? { duration_ms: result.durationMs } : {}),
    };
  });
}

function buildObservationTraceEntries(
  turn: TurnGroup,
  toolResultRows: StructuredAuditEntry[],
): Array<Record<string, unknown>> {
  return toolResultRows.map((row) => {
    const payload = parseJsonObject(row.payload);
    const resultSummary =
      readString(payload, 'resultSummary') ||
      truncateAuditText(JSON.stringify(payload), 280);
    return {
      source_call_id: readString(payload, 'toolCallId') || `${turn.runId}:tool`,
      content: resultSummary,
      output_summary: resultSummary,
      error: readBoolean(payload, 'isError') === true ? resultSummary : null,
    };
  });
}

function readTurnModelId(
  summary: TurnRowSummary,
  fallbackModel: string,
): string {
  const agentStartPayload = summary.agentStart
    ? parseJsonObject(summary.agentStart.payload)
    : null;
  return (
    formatModelForDisplay(
      readString(agentStartPayload || {}, 'model') || fallbackModel,
    ) || formatModelForDisplay(fallbackModel)
  );
}

function readTurnTokenUsage(
  summary: TurnRowSummary,
): Record<string, number> | undefined {
  const usagePayload = summary.usageRow
    ? parseJsonObject(summary.usageRow.payload)
    : null;
  return buildStepTokenUsage(usagePayload);
}

function readTurnFinishReason(summary: TurnRowSummary): string | null {
  const turnEndPayload = summary.turnEnd
    ? parseJsonObject(summary.turnEnd.payload)
    : null;
  return turnEndPayload ? readString(turnEndPayload, 'finishReason') : null;
}

function resolveTurnAgentContent(
  summary: TurnRowSummary,
  finishReason: string | null,
  assistantMessages: StoredMessage[],
  assistantIndex: number,
): {
  content: string;
  nextAssistantIndex: number;
  completed: boolean;
  errored: boolean;
} {
  if (finishReason === 'completed') {
    return {
      content: assistantMessages[assistantIndex]?.content || '',
      nextAssistantIndex: assistantIndex + 1,
      completed: true,
      errored: false,
    };
  }

  const errorPayload = summary.errorRow
    ? parseJsonObject(summary.errorRow.payload)
    : null;
  return {
    content: readString(errorPayload || {}, 'message') || '',
    nextAssistantIndex: assistantIndex,
    completed: false,
    errored: true,
  };
}

function readTurnStepTimestamp(
  turn: TurnGroup,
  summary: TurnRowSummary,
): string {
  return (
    summary.agentStart?.timestamp ||
    summary.usageRow?.timestamp ||
    summary.turnEnd?.timestamp ||
    turn.turnStart.timestamp
  );
}

function buildTraceSteps(params: {
  turns: TurnGroup[];
  messages: StoredMessage[];
  fallbackModel: string;
  systemPromptHashByRunId: Map<string, string>;
}): {
  steps: Array<Record<string, unknown>>;
  agentStepIndexByRunId: Map<string, number>;
  completedTurns: number;
  errorTurns: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  const assistantMessages = params.messages.filter(
    (message) => message.role === 'assistant',
  );
  const steps: Array<Record<string, unknown>> = [];
  let assistantIndex = 0;
  let stepIndex = 0;
  let completedTurns = 0;
  let errorTurns = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  const agentStepIndexByRunId = new Map<string, number>();

  for (const turn of params.turns) {
    const summary = summarizeTurnRows(turn.rows);
    const userStep = buildUserTraceStep(turn, stepIndex);
    if (userStep) {
      steps.push(userStep);
      stepIndex += 1;
    }

    const resultByToolCallId = buildToolResultByCallId(summary.toolResultRows);
    const toolCalls = buildToolCallTraceEntries(
      turn,
      summary.toolCallRows,
      resultByToolCallId,
    );
    const observations = buildObservationTraceEntries(
      turn,
      summary.toolResultRows,
    );
    const finishReason = readTurnFinishReason(summary);
    const modelId = readTurnModelId(summary, params.fallbackModel);
    const stepTokenUsage = readTurnTokenUsage(summary);
    if (stepTokenUsage?.cache_read_tokens) {
      cacheReadTokens += stepTokenUsage.cache_read_tokens;
    }
    if (stepTokenUsage?.cache_write_tokens) {
      cacheWriteTokens += stepTokenUsage.cache_write_tokens;
    }

    const resolvedContent = resolveTurnAgentContent(
      summary,
      finishReason,
      assistantMessages,
      assistantIndex,
    );
    assistantIndex = resolvedContent.nextAssistantIndex;
    if (resolvedContent.completed) completedTurns += 1;
    if (resolvedContent.errored) errorTurns += 1;

    agentStepIndexByRunId.set(turn.runId, stepIndex);
    steps.push({
      step_index: stepIndex,
      role: 'agent',
      ...(resolvedContent.content ? { content: resolvedContent.content } : {}),
      model: modelId,
      ...(params.systemPromptHashByRunId.get(turn.runId)
        ? {
            system_prompt_hash: params.systemPromptHashByRunId.get(turn.runId),
          }
        : {}),
      agent_role: 'main',
      call_type: 'main',
      tool_calls: toolCalls,
      observations,
      snippets: [],
      ...(stepTokenUsage ? { token_usage: stepTokenUsage } : {}),
      timestamp: readTurnStepTimestamp(turn, summary),
    });
    stepIndex += 1;
  }

  return {
    steps,
    agentStepIndexByRunId,
    completedTurns,
    errorTurns,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

function collectTraceAttributionPaths(turns: TurnGroup[]): string[] {
  const filePaths = new Set<string>();
  for (const turn of turns) {
    const summary = summarizeTurnRows(turn.rows);
    const resultByToolCallId = buildToolResultByCallId(summary.toolResultRows);
    for (const row of summary.toolCallRows) {
      const payload = parseJsonObject(row.payload);
      const toolCallId =
        readString(payload, 'toolCallId') || `${turn.runId}:tool`;
      const result = resultByToolCallId.get(toolCallId);
      if (result?.isError === true) continue;
      const filePath = extractToolFilePath(payload.arguments);
      if (filePath) filePaths.add(filePath);
    }
  }
  return [...filePaths];
}

function readToolStringArgument(
  argumentsValue: unknown,
  key: string,
): string | null {
  if (!isRecord(argumentsValue)) return null;
  const value = argumentsValue[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function countContentLines(text: string | null): number {
  if (!text) return 1;
  return Math.max(1, text.split('\n').length);
}

function buildAttributionRangesForToolCall(
  toolName: string,
  argumentsValue: unknown,
): Array<Record<string, unknown>> {
  if (toolName === 'write') {
    const content = readToolStringArgument(argumentsValue, 'content') || '';
    return [
      {
        start_line: 1,
        end_line: countContentLines(content),
        content_hash: shortContentHash(content),
        confidence: 'high',
      },
    ];
  }

  if (toolName === 'edit') {
    const newString =
      readToolStringArgument(argumentsValue, 'new_string') ||
      readToolStringArgument(argumentsValue, 'newString') ||
      '';
    return [
      {
        start_line: 1,
        end_line: countContentLines(newString),
        content_hash: shortContentHash(newString),
        confidence: 'low',
      },
    ];
  }

  return [];
}

function buildTraceAttribution(params: {
  turns: TurnGroup[];
  agentStepIndexByRunId: Map<string, number>;
  workspaceRoot: string;
  repoRoot: string | null;
}): Record<string, unknown> | null {
  const files = new Map<string, Map<number, Array<Record<string, unknown>>>>();

  for (const turn of params.turns) {
    const summary = summarizeTurnRows(turn.rows);
    const resultByToolCallId = buildToolResultByCallId(summary.toolResultRows);
    for (const row of summary.toolCallRows) {
      const payload = parseJsonObject(row.payload);
      const toolName = readString(payload, 'toolName') || '';
      if (!['edit', 'write'].includes(toolName)) continue;
      const toolCallId =
        readString(payload, 'toolCallId') || `${turn.runId}:tool`;
      const result = resultByToolCallId.get(toolCallId);
      if (result?.isError === true) continue;
      const filePath = extractToolFilePath(payload.arguments);
      if (!filePath) continue;

      const normalizedPath = normalizeAttributionPath(
        filePath,
        params.repoRoot,
        params.workspaceRoot,
      );
      const stepIndex = params.agentStepIndexByRunId.get(turn.runId);
      if (stepIndex == null) continue;
      const ranges = buildAttributionRangesForToolCall(
        toolName,
        payload.arguments,
      );
      if (ranges.length === 0) continue;
      const conversations = files.get(normalizedPath) || new Map();
      const stepRanges = conversations.get(stepIndex) || [];
      stepRanges.push(...ranges);
      conversations.set(stepIndex, stepRanges);
      files.set(normalizedPath, conversations);
    }
  }

  if (files.size === 0) return null;
  return {
    version: OPENTRACES_SCHEMA_VERSION,
    experimental: true,
    files: [...files.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([filePath, conversations]) => ({
        path: filePath,
        conversations: [...conversations.entries()]
          .sort(([left], [right]) => left - right)
          .map(([stepIndex, ranges]) => ({
            contributor: { type: 'ai' },
            url: `opentraces://trace/step_${stepIndex}`,
            ranges,
          })),
      })),
  };
}

function buildTraceToolDefinitions(
  turns: TurnGroup[],
): Array<Record<string, unknown>> {
  const toolNames = new Set<string>();
  for (const turn of turns) {
    const summary = summarizeTurnRows(turn.rows);
    for (const row of summary.toolCallRows) {
      const payload = parseJsonObject(row.payload);
      const toolName = readString(payload, 'toolName');
      if (toolName) toolNames.add(toolName);
    }
  }
  return [...toolNames]
    .sort((left, right) => left.localeCompare(right))
    .map((toolName) => ({ name: toolName }));
}

function detectCommittedOutcomeFromSteps(
  steps: Array<Record<string, unknown>>,
): Partial<Record<string, unknown>> {
  for (const step of steps) {
    if (step.role !== 'agent') continue;
    const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    const observations = Array.isArray(step.observations)
      ? step.observations
      : [];
    for (const toolCall of toolCalls) {
      if (!isRecord(toolCall) || toolCall.tool_name !== 'bash') continue;
      const input = isRecord(toolCall.input) ? toolCall.input : {};
      const command = typeof input.command === 'string' ? input.command : '';
      if (!command.includes('git commit')) continue;
      const toolCallId =
        typeof toolCall.tool_call_id === 'string' ? toolCall.tool_call_id : '';
      const observation = observations.find((entry) => {
        return isRecord(entry) && entry.source_call_id === toolCallId;
      });
      const content =
        isRecord(observation) && typeof observation.content === 'string'
          ? observation.content
          : '';
      const shaMatch =
        /\[[\w/.-]+(?:\s+\(root-commit\))?\s+([a-f0-9]{7,40})\]/i.exec(content);
      if (!shaMatch?.[1]) continue;
      const messageMatch = /\[[^\]]+\]\s+(.+?)(?:\n|$)/.exec(content);
      return {
        success: true,
        committed: true,
        commit_sha: shaMatch[1],
        description: messageMatch?.[1]?.trim() || undefined,
      };
    }
  }
  return {};
}

function countOccurrences(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function buildTraceSecurityMetadata(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const serialized = stableStringify(record);
  return {
    scanned: true,
    flags_reviewed: 0,
    redactions_applied:
      countOccurrences(serialized, /\*\*\*[A-Z0-9_]+REDACTED\*\*\*/g) +
      countOccurrences(serialized, /\buser_[a-f0-9]{8}\b/g),
    classifier_version: null,
  };
}

async function writeJsonlFile(
  filePath: string,
  rows: unknown[],
): Promise<boolean> {
  try {
    const lines = rows.map((row) => JSON.stringify(row)).join('\n');
    await fs.promises.writeFile(filePath, `${lines}\n`, 'utf8');
    return true;
  } catch (err) {
    logger.warn(
      { filePath, err },
      'Failed to write session trace export JSONL',
    );
    return false;
  }
}

export async function exportSessionTraceAtifJsonl(params: {
  agentId: string;
  session: Session;
  messages: StoredMessage[];
  auditEntries: StructuredAuditEntry[];
  usageTotals: UsageTotals;
}): Promise<{
  path: string;
  lineCount: number;
  traceId: string;
  stepCount: number;
} | null> {
  const agentId = params.agentId.trim();
  const sessionId = params.session.id.trim();
  if (!agentId || !sessionId) return null;

  try {
    const baseDir = exportBaseDir(agentId, sessionId);
    await fs.promises.mkdir(baseDir, { recursive: true });
    const filePath = exportFilePath(baseDir);

    const turns = groupTurnRows(params.auditEntries);
    const fallbackModel = params.session.model || '';
    const { systemPrompts, systemPromptHashByRunId } =
      buildTraceSystemPrompts(turns);
    const traceData =
      turns.length > 0
        ? buildTraceSteps({
            turns,
            messages: params.messages,
            fallbackModel,
            systemPromptHashByRunId,
          })
        : {
            steps: buildFallbackSteps(params.messages),
            agentStepIndexByRunId: new Map<string, number>(),
            completedTurns: 0,
            errorTurns: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          };
    const steps = traceData.steps;

    const firstTimestampValue = steps[0]?.timestamp;
    const firstTimestamp =
      typeof firstTimestampValue === 'string'
        ? firstTimestampValue
        : params.session.created_at || new Date().toISOString();
    const lastTimestampValue = steps[steps.length - 1]?.timestamp;
    const lastTimestamp =
      typeof lastTimestampValue === 'string'
        ? lastTimestampValue
        : params.session.last_active || firstTimestamp;
    const normalizedModel =
      formatModelForDisplay(params.session.model || fallbackModel) || '';
    const firstUserStep = steps.find((step) => step.role === 'user');
    const firstUserContent =
      typeof firstUserStep?.content === 'string' ? firstUserStep.content : null;
    const totalDurationSeconds = Math.max(
      0,
      Math.round(
        (new Date(lastTimestamp).getTime() -
          new Date(firstTimestamp).getTime()) /
          1000,
      ),
    );
    const traceId = deterministicUuid(
      `${sessionId}:${params.session.created_at}:${agentId}`,
    );

    const attributionPaths = collectTraceAttributionPaths(turns);
    const projectContext = resolveTraceProjectContext(
      agentId,
      attributionPaths,
    );
    const attribution = buildTraceAttribution({
      turns,
      agentStepIndexByRunId: traceData.agentStepIndexByRunId,
      workspaceRoot: projectContext.workspaceRoot,
      repoRoot: projectContext.repoRoot,
    });
    const limitations =
      turns.length === 0
        ? [...TRACE_EXPORT_BASE_LIMITATIONS, TRACE_EXPORT_FALLBACK_LIMITATION]
        : [...TRACE_EXPORT_BASE_LIMITATIONS];
    const committedOutcome = detectCommittedOutcomeFromSteps(steps);

    const recordWithoutHash: Record<string, unknown> = {
      schema_version: OPENTRACES_SCHEMA_VERSION,
      trace_id: traceId,
      session_id: sessionId,
      timestamp_start: firstTimestamp,
      timestamp_end: lastTimestamp,
      task: {
        description: truncateText(
          firstUserContent ||
            params.session.session_summary ||
            `Session ${sessionId}`,
        ),
        source: 'user_prompt',
        repository: projectContext.repository,
        base_commit: projectContext.baseCommit,
      },
      agent: {
        name: 'hybridclaw',
        version: APP_VERSION,
        ...(normalizedModel ? { model: normalizedModel } : {}),
      },
      environment: {
        os: os.platform(),
        shell: path.basename(process.env.SHELL || '') || null,
        vcs: projectContext.repoRoot
          ? {
              type: 'git',
              base_commit: projectContext.baseCommit,
              branch: projectContext.branch,
              diff: projectContext.diff,
            }
          : {
              type: 'none',
              base_commit: null,
              branch: null,
              diff: null,
            },
        language_ecosystem: projectContext.languageEcosystem,
      },
      system_prompts: systemPrompts,
      tool_definitions: buildTraceToolDefinitions(turns),
      steps,
      outcome: {
        success:
          steps.length > 0
            ? traceData.errorTurns === 0 ||
              (traceData.completedTurns > 0 &&
                traceData.completedTurns >= traceData.errorTurns)
            : false,
        signal_source: 'deterministic',
        signal_confidence: 'derived',
        description:
          traceData.errorTurns > 0
            ? `Exported ${traceData.completedTurns} completed turns and ${traceData.errorTurns} failed turn(s).`
            : `Exported ${traceData.completedTurns || Math.max(0, Math.floor(steps.length / 2))} completed turn(s).`,
        ...committedOutcome,
      },
      dependencies: projectContext.dependencies,
      metrics: {
        total_steps: steps.length,
        total_input_tokens: params.usageTotals.total_input_tokens,
        total_output_tokens: params.usageTotals.total_output_tokens,
        total_duration_s: totalDurationSeconds,
        ...(traceData.cacheReadTokens + traceData.cacheWriteTokens > 0
          ? {
              cache_hit_rate:
                traceData.cacheReadTokens /
                (traceData.cacheReadTokens + traceData.cacheWriteTokens),
            }
          : {}),
        ...(params.usageTotals.total_cost_usd > 0
          ? { estimated_cost_usd: params.usageTotals.total_cost_usd }
          : {}),
      },
      attribution,
      metadata: {
        exported_at: new Date().toISOString(),
        compatibility: {
          opentraces_schema_version: OPENTRACES_SCHEMA_VERSION,
          atif_version: ATIF_COMPAT_VERSION,
          mode: 'ATIF v1.6 compatible core with opentraces top-level envelope',
        },
        hybridclaw: {
          agent_id: agentId,
          channel_id: params.session.channel_id,
          show_mode: params.session.show_mode,
          audit_event_count: params.auditEntries.length,
          stored_message_count: params.messages.length,
          usage_call_count: params.usageTotals.call_count,
          tool_call_count: params.usageTotals.total_tool_calls,
        },
        ...(params.session.session_summary
          ? {
              session_summary: truncateText(params.session.session_summary),
            }
          : {}),
        limitations,
      },
    };

    const sanitizedRecord = finalizeTraceRecord(recordWithoutHash);
    const security = buildTraceSecurityMetadata(sanitizedRecord);
    const finalizedRecord = {
      ...sanitizedRecord,
      security,
    };
    const contentHashBase = {
      ...(finalizedRecord as Record<string, unknown>),
    };
    delete contentHashBase.trace_id;
    delete contentHashBase.content_hash;
    const contentHash = sha256Hex(stableStringify(contentHashBase));
    const record = {
      ...finalizedRecord,
      content_hash: contentHash,
    };

    if (!(await writeJsonlFile(filePath, [record]))) return null;
    return {
      path: filePath,
      lineCount: 1,
      traceId,
      stepCount: steps.length,
    };
  } catch (err) {
    logger.warn({ agentId, sessionId, err }, 'Failed to export session trace');
    return null;
  }
}
