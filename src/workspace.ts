/**
 * Workspace bootstrap files — loads SOUL.md, IDENTITY.md, USER.md,
 * TOOLS.md, MEMORY.md, HEARTBEAT.md from the agent workspace
 * and injects them into the system prompt (like OpenClaw).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  currentDateStampInTimezone,
  extractUserTimezone,
} from '../container/shared/workspace-time.js';
import { resolveInstallPath } from './infra/install-root.js';
import { agentWorkspaceDir } from './infra/ipc.js';
import { logger } from './logger.js';
import { truncateHeadTailText } from './session/token-efficiency.js';

export const WORKSPACE_BOOTSTRAP_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'TOOLS.md',
  'MEMORY.md',
  'HEARTBEAT.md',
  'BOOTSTRAP.md',
  'OPENING.md',
  'BOOT.md',
] as const;
const ONE_TIME_BOOTSTRAP_FILES = new Set(['BOOTSTRAP.md']);
const WORKSPACE_STATE_DIRNAME = '.hybridclaw';
const WORKSPACE_STATE_FILENAME = 'workspace-state.json';
const WORKSPACE_STATE_VERSION = 1;
const POLICY_RELATIVE_PATH = path.join('.hybridclaw', 'policy.yaml');
const DEFAULT_POLICY_TEMPLATE = `approval:
  pinned_red:
    - pattern: "rm -rf /"
    - paths: ["~/.ssh/**", "/etc/**", ".env*"]
    - tools: ["force_push"]
  workspace_fence: true
  max_pending_approvals: 3
  approval_timeout_secs: 120

network:
  default: deny
  rules:
    - action: allow
      host: "hybridclaw.io"
      port: 443
      methods: ["*"]
      paths: ["/**"]
      agent: "*"
  presets: []

audit:
  log_all_red: true
  log_denials: true
`;

const MAX_FILE_CHARS = 20_000;
const TEMPLATES_DIR = resolveInstallPath('templates');

/**
 * Directory (inside the agent container image) where runtime node_modules
 * are installed. Skill scripts that run from `/workspace/...` need ESM
 * resolution to walk up into this directory; Node's ESM loader ignores
 * NODE_PATH, so we symlink `<workspace>/node_modules` at bootstrap time.
 */
const CONTAINER_APP_NODE_MODULES = '/app/node_modules';

export interface ContextFile {
  name: string;
  content: string;
}

export interface EnsureBootstrapFilesResult {
  workspacePath: string;
  workspaceInitialized: boolean;
}

export interface ResetWorkspaceResult {
  workspacePath: string;
  removed: boolean;
}

interface WorkspaceNodeModulesLinkOptions {
  allowMissingSource?: boolean;
  replaceExistingSymlink?: boolean;
}

interface WorkspaceOnboardingState {
  version: typeof WORKSPACE_STATE_VERSION;
  bootstrapSeededAt?: string;
  onboardingCompletedAt?: string;
}

function resolveWorkspaceStatePath(wsDir: string): string {
  return path.join(wsDir, WORKSPACE_STATE_DIRNAME, WORKSPACE_STATE_FILENAME);
}

function isWorkspaceEffectivelyEmpty(wsDir: string): boolean {
  try {
    const entries = fs
      .readdirSync(wsDir)
      .filter((entry) => entry !== '.DS_Store' && entry !== 'Thumbs.db');
    return entries.length === 0;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return true;
    logger.warn({ wsDir, error }, 'Failed to inspect workspace contents');
    return false;
  }
}

function readWorkspaceOnboardingState(
  statePath: string,
): WorkspaceOnboardingState {
  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      bootstrapSeededAt?: unknown;
      onboardingCompletedAt?: unknown;
    };
    if (!parsed || typeof parsed !== 'object') {
      return { version: WORKSPACE_STATE_VERSION };
    }
    return {
      version: WORKSPACE_STATE_VERSION,
      bootstrapSeededAt:
        typeof parsed.bootstrapSeededAt === 'string'
          ? parsed.bootstrapSeededAt
          : undefined,
      onboardingCompletedAt:
        typeof parsed.onboardingCompletedAt === 'string'
          ? parsed.onboardingCompletedAt
          : undefined,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') {
      return { version: WORKSPACE_STATE_VERSION };
    }
    logger.warn({ statePath, error }, 'Failed to read workspace state');
    return { version: WORKSPACE_STATE_VERSION };
  }
}

function writeWorkspaceOnboardingState(
  statePath: string,
  state: WorkspaceOnboardingState,
): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  fs.writeFileSync(tempPath, payload, 'utf-8');
  fs.renameSync(tempPath, statePath);
}

function readTemplateFile(
  filename: (typeof WORKSPACE_BOOTSTRAP_FILES)[number],
): string {
  const templatePath = path.join(TEMPLATES_DIR, filename);
  return fs.readFileSync(templatePath, 'utf-8');
}

function stripMarkdownSection(content: string, heading: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const targetHeading = `## ${heading}`;
  const startIndex = lines.findIndex((line) => line.trim() === targetHeading);
  if (startIndex === -1) return content;

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (lines[index]?.startsWith('## ')) {
      endIndex = index;
      break;
    }
  }

  const nextLines = [...lines.slice(0, startIndex), ...lines.slice(endIndex)];
  return nextLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeContextFileContent(params: {
  agentId: string;
  name: string;
  content: string;
}): string {
  const { agentId, name } = params;
  let content = params.content;

  if (name === 'AGENTS.md' && !isBootstrapping(agentId)) {
    content = stripMarkdownSection(content, 'First Run');
  }

  return content;
}

function isWorkspaceFileCustomized(
  wsDir: string,
  filename: (typeof WORKSPACE_BOOTSTRAP_FILES)[number],
): boolean {
  const filePath = path.join(wsDir, filename);
  if (!fs.existsSync(filePath)) return false;
  try {
    return fs.readFileSync(filePath, 'utf-8') !== readTemplateFile(filename);
  } catch (error) {
    logger.warn(
      { wsDir, file: filename, error },
      'Failed to compare workspace file against template',
    );
    return false;
  }
}

function hasWorkspaceUserContent(wsDir: string): boolean {
  if (fs.existsSync(path.join(wsDir, 'memory'))) return true;
  if (fs.existsSync(path.join(wsDir, '.git'))) return true;
  if (fs.existsSync(path.join(wsDir, '.session-transcripts'))) return true;
  return isWorkspaceFileCustomized(wsDir, 'MEMORY.md');
}

function readBootstrapReferenceTimestampMs(params: {
  wsDir: string;
  state: WorkspaceOnboardingState;
}): number | null {
  const seededAt = Date.parse(String(params.state.bootstrapSeededAt || ''));
  if (Number.isFinite(seededAt)) return seededAt;

  try {
    const stat = fs.statSync(path.join(params.wsDir, 'BOOTSTRAP.md'));
    return Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

function hasPathChangedAfter(referenceMs: number, targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).mtimeMs > referenceMs;
  } catch {
    return false;
  }
}

function hasOnboardingEvidenceAfterBootstrap(params: {
  wsDir: string;
  state: WorkspaceOnboardingState;
}): boolean {
  const referenceMs = readBootstrapReferenceTimestampMs(params);
  if (referenceMs == null) return false;

  const transcriptPath = path.join(params.wsDir, '.session-transcripts');
  if (hasPathChangedAfter(referenceMs, transcriptPath)) return true;

  const customizedFiles: Array<(typeof WORKSPACE_BOOTSTRAP_FILES)[number]> = [
    'USER.md',
    'MEMORY.md',
    'IDENTITY.md',
  ];
  for (const filename of customizedFiles) {
    if (!isWorkspaceFileCustomized(params.wsDir, filename)) continue;
    if (hasPathChangedAfter(referenceMs, path.join(params.wsDir, filename))) {
      return true;
    }
  }

  const contentDirs = ['memory', '.git'];
  for (const dirname of contentDirs) {
    if (hasPathChangedAfter(referenceMs, path.join(params.wsDir, dirname))) {
      return true;
    }
  }

  return false;
}

function hasInteractiveOnboardingEvidenceAfterBootstrap(params: {
  wsDir: string;
  state: WorkspaceOnboardingState;
}): boolean {
  const referenceMs = readBootstrapReferenceTimestampMs(params);
  if (referenceMs == null) return false;

  const interactiveDirs = ['.session-transcripts', 'memory', '.git'];
  for (const dirname of interactiveDirs) {
    if (hasPathChangedAfter(referenceMs, path.join(params.wsDir, dirname))) {
      return true;
    }
  }

  return false;
}

function looksLikeCompletedWorkspace(
  wsDir: string,
  bootstrapExists: boolean,
  state: WorkspaceOnboardingState,
): boolean {
  const customizedIdentity = isWorkspaceFileCustomized(wsDir, 'IDENTITY.md');
  const customizedUser = isWorkspaceFileCustomized(wsDir, 'USER.md');
  const userContentPresent = hasWorkspaceUserContent(wsDir);
  const customizedBootstrap =
    bootstrapExists && isWorkspaceFileCustomized(wsDir, 'BOOTSTRAP.md');

  if (!bootstrapExists) {
    return customizedIdentity || customizedUser || userContentPresent;
  }

  if (
    customizedBootstrap &&
    !hasInteractiveOnboardingEvidenceAfterBootstrap({ wsDir, state })
  ) {
    return false;
  }

  if (!hasOnboardingEvidenceAfterBootstrap({ wsDir, state })) {
    return false;
  }

  return (customizedIdentity || customizedUser) && userContentPresent;
}

/**
 * Symlink `<wsDir>/node_modules` to the container's `/app/node_modules` so
 * Node's ESM loader can resolve dependencies from skill scripts that live
 * under the workspace. Node's ESM resolver walks up the filesystem looking
 * for `node_modules` and — unlike CommonJS `require()` — ignores `NODE_PATH`,
 * which is why ESM imports fail even though the deps are installed in
 * `/app/node_modules`.
 *
 * Only creates the symlink when nothing exists at the destination; a
 * pre-existing `node_modules` directory is left untouched so user-installed
 * deps aren't clobbered. Callers can opt into replacing an existing symlink
 * when they need to repair a stale runtime link before launching Docker.
 *
 * When the source `/app/node_modules` doesn't exist (e.g. outside the
 * container) this is normally a silent no-op. Docker launch paths can opt into
 * creating the symlink anyway so the bind-mounted workspace is already correct
 * when the container starts.
 *
 * Exported for tests.
 */
export function ensureWorkspaceNodeModulesLink(
  wsDir: string,
  source: string = CONTAINER_APP_NODE_MODULES,
  options: WorkspaceNodeModulesLinkOptions = {},
): void {
  const target = path.join(wsDir, 'node_modules');
  const resolvedSource = path.resolve(source);
  let replaceExistingSymlink = false;

  // `lstat` so we detect a broken symlink at `target` too.
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isSymbolicLink()) {
      // A real directory/file already exists — leave it alone.
      return;
    }

    if (!options.replaceExistingSymlink) return;

    const existingTarget = fs.readlinkSync(target);
    const resolvedExisting = path.resolve(path.dirname(target), existingTarget);
    if (resolvedExisting === resolvedSource) return;
    replaceExistingSymlink = true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code !== 'ENOENT') {
      logger.warn(
        { wsDir, target, error },
        'Failed to inspect workspace node_modules path',
      );
      return;
    }
  }

  // Only create the link if the source actually exists unless the caller is
  // deliberately staging a dangling container-path symlink before `docker run`.
  if (!fs.existsSync(source) && !options.allowMissingSource) return;

  try {
    if (replaceExistingSymlink) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    fs.symlinkSync(source, target, 'dir');
    logger.debug(
      { wsDir, source, target },
      'Linked workspace node_modules to container app deps',
    );
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // Benign race: another bootstrap pass created it first.
    if (err?.code === 'EEXIST') return;
    logger.warn(
      { wsDir, source, target, error },
      'Failed to symlink workspace node_modules',
    );
  }
}

/**
 * Ensure workspace has bootstrap files, copying from templates if missing.
 */
export function ensureBootstrapFiles(
  agentId: string,
): EnsureBootstrapFilesResult {
  const wsDir = agentWorkspaceDir(agentId);
  const workspaceInitialized =
    !fs.existsSync(wsDir) || isWorkspaceEffectivelyEmpty(wsDir);
  fs.mkdirSync(wsDir, { recursive: true });
  const statePath = resolveWorkspaceStatePath(wsDir);
  let state = readWorkspaceOnboardingState(statePath);
  let stateDirty = false;
  const markState = (next: Partial<WorkspaceOnboardingState>) => {
    state = { ...state, ...next };
    stateDirty = true;
  };
  const nowIso = () => new Date().toISOString();

  for (const filename of WORKSPACE_BOOTSTRAP_FILES) {
    if (ONE_TIME_BOOTSTRAP_FILES.has(filename)) continue;
    const destPath = path.join(wsDir, filename);
    if (fs.existsSync(destPath)) continue;

    const templatePath = path.join(TEMPLATES_DIR, filename);
    if (fs.existsSync(templatePath)) {
      fs.copyFileSync(templatePath, destPath);
      logger.debug({ agentId, file: filename }, 'Copied bootstrap template');
    }
  }

  const bootstrapPath = path.join(wsDir, 'BOOTSTRAP.md');
  let bootstrapExists = fs.existsSync(bootstrapPath);
  if (bootstrapExists && !state.bootstrapSeededAt) {
    markState({ bootstrapSeededAt: nowIso() });
  }

  const shouldCompleteOnboarding =
    Boolean(state.onboardingCompletedAt) ||
    looksLikeCompletedWorkspace(wsDir, bootstrapExists, state);

  if (shouldCompleteOnboarding) {
    if (bootstrapExists) {
      fs.unlinkSync(bootstrapPath);
      bootstrapExists = false;
      logger.debug(
        { agentId, path: bootstrapPath },
        'Removed stale BOOTSTRAP.md',
      );
    }
    if (!state.onboardingCompletedAt) {
      markState({ onboardingCompletedAt: nowIso() });
    }
  }

  if (
    !state.onboardingCompletedAt &&
    state.bootstrapSeededAt &&
    !bootstrapExists
  ) {
    markState({ onboardingCompletedAt: nowIso() });
  }

  if (!state.onboardingCompletedAt && !bootstrapExists) {
    const templatePath = path.join(TEMPLATES_DIR, 'BOOTSTRAP.md');
    if (fs.existsSync(templatePath)) {
      fs.copyFileSync(templatePath, bootstrapPath);
      bootstrapExists = true;
      logger.debug(
        { agentId, file: 'BOOTSTRAP.md' },
        'Copied bootstrap template',
      );
      if (!state.bootstrapSeededAt) {
        markState({ bootstrapSeededAt: nowIso() });
      }
    }
  }

  if (stateDirty) {
    writeWorkspaceOnboardingState(statePath, state);
  }

  const policyDestPath = path.join(wsDir, POLICY_RELATIVE_PATH);
  if (!fs.existsSync(policyDestPath)) {
    fs.mkdirSync(path.dirname(policyDestPath), { recursive: true });
    const repoPolicyPath = resolveInstallPath(POLICY_RELATIVE_PATH);
    if (fs.existsSync(repoPolicyPath)) {
      fs.copyFileSync(repoPolicyPath, policyDestPath);
      logger.debug(
        { agentId, file: POLICY_RELATIVE_PATH },
        'Copied approval policy from repository',
      );
    } else {
      fs.writeFileSync(policyDestPath, DEFAULT_POLICY_TEMPLATE, 'utf-8');
      logger.debug(
        { agentId, file: POLICY_RELATIVE_PATH },
        'Wrote default approval policy template',
      );
    }
  }

  ensureWorkspaceNodeModulesLink(wsDir);

  return {
    workspacePath: wsDir,
    workspaceInitialized,
  };
}

export function resetWorkspace(agentId: string): ResetWorkspaceResult {
  const workspacePath = agentWorkspaceDir(agentId);
  const removed = fs.existsSync(workspacePath);
  fs.rmSync(workspacePath, { recursive: true, force: true });
  return {
    workspacePath,
    removed,
  };
}

/**
 * Load all bootstrap files from the workspace.
 * Returns only files that exist and have content.
 */
export function loadBootstrapFiles(agentId: string): ContextFile[] {
  const wsDir = agentWorkspaceDir(agentId);
  const files: ContextFile[] = [];

  for (const filename of WORKSPACE_BOOTSTRAP_FILES) {
    const filePath = path.join(wsDir, filename);
    if (!fs.existsSync(filePath)) continue;

    try {
      let content = fs.readFileSync(filePath, 'utf-8').trim();
      if (!content) continue;

      content = normalizeContextFileContent({
        agentId,
        name: filename,
        content,
      });
      if (!content) continue;

      if (content.length > MAX_FILE_CHARS) {
        content = truncateHeadTailText(content, MAX_FILE_CHARS);
      }

      files.push({ name: filename, content });
    } catch (err) {
      logger.warn(
        { agentId, file: filename, err },
        'Failed to read bootstrap file',
      );
    }
  }

  const userTimezone = resolveUserTimezoneFromContextFiles(files);
  const todayMemoryName = `memory/${currentDateStampInTimezone(userTimezone)}.md`;
  const todayMemoryPath = path.join(wsDir, todayMemoryName);
  if (fs.existsSync(todayMemoryPath)) {
    try {
      const raw = readBoundedWorkspaceTextFile(todayMemoryPath, MAX_FILE_CHARS);
      if (raw == null) {
        throw new Error('Failed to read daily memory file');
      }
      const content = raw.trim();
      if (content) {
        files.push({ name: todayMemoryName, content });
      }
    } catch (err) {
      logger.warn(
        { agentId, file: todayMemoryName, err },
        'Failed to read daily memory file',
      );
    }
  }

  return files;
}

/**
 * Format the current date/time in a human-friendly way, like OpenClaw.
 * e.g. "Tuesday, February 24th, 2026 — 14:32"
 */
function formatCurrentTime(timezone?: string): string {
  const tz =
    timezone?.trim() ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC';
  const now = new Date();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== 'literal') map[part.type] = part.value;
    }
    if (
      !map.weekday ||
      !map.year ||
      !map.month ||
      !map.day ||
      !map.hour ||
      !map.minute
    ) {
      return now.toISOString();
    }
    const dayNum = parseInt(map.day, 10);
    const suffix =
      dayNum >= 11 && dayNum <= 13
        ? 'th'
        : dayNum % 10 === 1
          ? 'st'
          : dayNum % 10 === 2
            ? 'nd'
            : dayNum % 10 === 3
              ? 'rd'
              : 'th';
    return `${map.weekday}, ${map.month} ${dayNum}${suffix}, ${map.year} — ${map.hour}:${map.minute} (${tz})`;
  } catch {
    return now.toISOString();
  }
}

function resolveUserTimezoneFromContextFiles(
  files: ContextFile[],
): string | undefined {
  const userFile = files.find((file) => file.name === 'USER.md');
  return extractUserTimezone(userFile?.content);
}

function readBoundedWorkspaceTextFile(
  filePath: string,
  maxChars: number,
): string | null {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size <= 0) return '';
    if (stats.size <= maxChars) {
      return fs.readFileSync(filePath, 'utf-8');
    }

    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(maxChars);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return `${buffer.toString('utf8', 0, bytesRead)}\n...[truncated]`;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Build a system prompt section from loaded context files.
 * Injects current date/time (like OpenClaw) so the agent knows when "now" is.
 */
export function buildContextPrompt(files: ContextFile[]): string {
  if (files.length === 0) return '';

  const userTimezone = resolveUserTimezoneFromContextFiles(files);

  const lines: string[] = [
    '# Project Context',
    '',
    'The following workspace context files have been loaded.',
    'Treat SOUL.md, USER.md, MEMORY.md, and the other files below as already read for this turn.',
    'Any instruction inside these files to read SOUL.md, USER.md, or MEMORY.md is already satisfied by this prompt.',
    'Do not call the `read` tool on these files just to initialize context; only reread a file if you need to verify changes made after this prompt was built.',
    'If SOUL.md is present, embody its persona and tone.',
    '',
    '## Current Date & Time',
    formatCurrentTime(userTimezone),
    '',
  ];

  for (const file of files) {
    lines.push(`## ${file.name}`, '', file.content, '');
  }

  return lines.join('\n');
}

/**
 * Check if the workspace still needs bootstrapping.
 * Like OpenClaw: if the agent deleted BOOTSTRAP.md, or if IDENTITY.md / USER.md
 * have been modified from templates, bootstrapping is considered complete.
 */
export function isBootstrapping(agentId: string): boolean {
  const wsDir = agentWorkspaceDir(agentId);
  const statePath = resolveWorkspaceStatePath(wsDir);
  const state = readWorkspaceOnboardingState(statePath);
  if (state.onboardingCompletedAt) return false;

  const bootstrapPath = path.join(wsDir, 'BOOTSTRAP.md');
  const bootstrapExists = fs.existsSync(bootstrapPath);
  if (!bootstrapExists) return false;

  if (!looksLikeCompletedWorkspace(wsDir, true, state)) {
    return true;
  }

  try {
    fs.unlinkSync(bootstrapPath);
    writeWorkspaceOnboardingState(statePath, {
      ...state,
      version: WORKSPACE_STATE_VERSION,
      onboardingCompletedAt:
        state.onboardingCompletedAt || new Date().toISOString(),
    });
  } catch (error) {
    logger.warn(
      { agentId, path: bootstrapPath, error },
      'Failed to clean up stale BOOTSTRAP.md while checking bootstrapping state',
    );
    return true;
  }

  return false;
}

export function resolveStartupBootstrapFile(
  agentId: string,
): 'BOOTSTRAP.md' | 'OPENING.md' | null {
  if (isBootstrapping(agentId)) {
    return 'BOOTSTRAP.md';
  }

  const openingPath = path.join(agentWorkspaceDir(agentId), 'OPENING.md');
  if (!fs.existsSync(openingPath)) return null;
  try {
    const content = fs.readFileSync(openingPath, 'utf-8');
    if (!content.trim()) return null;
    return content === readTemplateFile('OPENING.md') ? null : 'OPENING.md';
  } catch (error) {
    logger.warn(
      { agentId, path: openingPath, error },
      'Failed to inspect OPENING.md while resolving startup bootstrap state',
    );
    return null;
  }
}
