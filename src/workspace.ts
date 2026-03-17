/**
 * Workspace bootstrap files — loads SOUL.md, IDENTITY.md, USER.md,
 * TOOLS.md, MEMORY.md, HEARTBEAT.md from the agent workspace
 * and injects them into the system prompt (like OpenClaw).
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveInstallPath } from './infra/install-root.js';
import { agentWorkspaceDir } from './infra/ipc.js';
import { logger } from './logger.js';
import { truncateHeadTailText } from './session/token-efficiency.js';

const BOOTSTRAP_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'TOOLS.md',
  'MEMORY.md',
  'HEARTBEAT.md',
  'BOOTSTRAP.md',
  'BOOT.md',
] as const;
const LIGHT_BOOTSTRAP_FILES: ReadonlySet<string> = new Set([
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'MEMORY.md',
] as const);
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

audit:
  log_all_red: true
  log_denials: true
`;

const MAX_FILE_CHARS = 20_000;
const TEMPLATES_DIR = resolveInstallPath('templates');

export interface ContextFile {
  name: string;
  content: string;
}

export type BootstrapContextMode = 'full' | 'light';

export interface EnsureBootstrapFilesResult {
  workspacePath: string;
  workspaceInitialized: boolean;
}

export interface ResetWorkspaceResult {
  workspacePath: string;
  removed: boolean;
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

function readTemplateFile(filename: (typeof BOOTSTRAP_FILES)[number]): string {
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
  filename: (typeof BOOTSTRAP_FILES)[number],
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

function looksLikeCompletedWorkspace(
  wsDir: string,
  bootstrapExists: boolean,
): boolean {
  const customizedIdentity = isWorkspaceFileCustomized(wsDir, 'IDENTITY.md');
  const customizedUser = isWorkspaceFileCustomized(wsDir, 'USER.md');
  const userContentPresent = hasWorkspaceUserContent(wsDir);

  if (!bootstrapExists) {
    return customizedIdentity || customizedUser || userContentPresent;
  }

  return (customizedIdentity || customizedUser) && userContentPresent;
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

  for (const filename of BOOTSTRAP_FILES) {
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
    looksLikeCompletedWorkspace(wsDir, bootstrapExists);

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
export function loadBootstrapFiles(
  agentId: string,
  options?: {
    mode?: BootstrapContextMode;
  },
): ContextFile[] {
  const wsDir = agentWorkspaceDir(agentId);
  const files: ContextFile[] = [];
  const mode = options?.mode || 'full';

  for (const filename of BOOTSTRAP_FILES) {
    if (mode === 'light' && !LIGHT_BOOTSTRAP_FILES.has(filename)) continue;
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

/**
 * Build a system prompt section from loaded context files.
 * Injects current date/time (like OpenClaw) so the agent knows when "now" is.
 */
export function buildContextPrompt(files: ContextFile[]): string {
  if (files.length === 0) return '';

  // Extract timezone from USER.md if available
  const userFile = files.find((f) => f.name === 'USER.md');
  const tzMatch = userFile?.content.match(/\*\*Timezone:\*\*\s*(.+)/i);
  const userTimezone = tzMatch?.[1]?.trim() || undefined;

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

  if (!looksLikeCompletedWorkspace(wsDir, true)) {
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
