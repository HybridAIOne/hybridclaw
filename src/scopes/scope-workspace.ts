/**
 * A scope's workspace: the agent's persona files (AGENTS, SOUL, IDENTITY,
 * TOOLS and the approval policy) copied in and refreshed when they change, a
 * USER.md that keeps only who the user is (name, language, timezone), and
 * the scope's own MEMORY.md, daily notes and transcripts.
 *
 * Invariant: nothing else of the agent workspace is ever copied in, and the
 * gateway writes here only by replacing files, so a link the model left in
 * the scope cannot redirect a write into the agent workspace.
 * NOT the path rules (`scope-paths.ts`).
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { agentWorkspaceDir } from '../infra/ipc.js';
import {
  ensureBootstrapFiles,
  readMarkdownField,
  readUserMarkdown,
} from '../workspace.js';
import {
  isPlainFileUnder,
  isRealScopeDir,
  scopeWorkspaceDir,
} from './scope-paths.js';

// Persona files a scope shares with its agent (product owner, 2026-10-09).
const MIRRORED_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'IDENTITY.md',
  'TOOLS.md',
  path.join('.hybridclaw', 'policy.yaml'),
];
// What a scope knows of the user (product owner, 2026-10-09): what to call
// them, their language and their timezone. Never the rest of USER.md.
const USER_FIELDS = [
  'What to call them',
  'Language',
  'Preferred language',
  'Timezone',
];

/** The scope's USER.md, generated from the agent's. */
export function renderScopeUserMarkdown(agentId: string): string {
  const source = readUserMarkdown(agentWorkspaceDir(agentId)) ?? '';
  const lines = USER_FIELDS.flatMap((field) => {
    const value = readMarkdownField(source, field);
    return value ? [`- **${field}:** ${value}`] : [];
  });
  return [
    '# USER.md - About Your Human',
    '',
    ...(lines.length > 0 ? lines : ['- **What to call them:**']),
    '',
  ].join('\n');
}

function readIfPlain(rootDir: string, relativePath: string): string | null {
  if (!isPlainFileUnder(rootDir, relativePath)) return null;
  try {
    return fs.readFileSync(path.join(rootDir, relativePath), 'utf-8');
  } catch {
    return null;
  }
}

/** Replaces the file itself, never what a link at that path points to. */
function replaceFile(
  rootDir: string,
  relativePath: string,
  content: string,
): void {
  const target = path.join(rootDir, relativePath);
  const dir = path.dirname(target);
  if (dir !== rootDir) {
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) {
      fs.rmSync(dir, { force: true });
    }
    fs.mkdirSync(dir, { recursive: true });
  }
  const temporary = path.join(dir, `.scope-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o644 });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * Creates or refreshes a scope's workspace and returns its path. Files the
 * scope mirrors follow the agent's: changed when the agent's changed,
 * removed when the agent has none.
 */
export function ensureScopeWorkspace(agentId: string, scopeId: string): string {
  ensureBootstrapFiles(agentId);
  const agentDir = agentWorkspaceDir(agentId);
  const scopeDir = scopeWorkspaceDir(agentId, scopeId);
  fs.mkdirSync(scopeDir, { recursive: true });
  if (!isRealScopeDir(agentId, scopeId)) {
    throw new Error(`Scope directory is not where it belongs: ${scopeDir}`);
  }
  for (const relativePath of MIRRORED_FILES) {
    const source = readIfPlain(agentDir, relativePath);
    const current = readIfPlain(scopeDir, relativePath);
    if (source === null) {
      if (fs.existsSync(path.join(scopeDir, relativePath))) {
        fs.rmSync(path.join(scopeDir, relativePath), { force: true });
      }
      continue;
    }
    if (current !== source) replaceFile(scopeDir, relativePath, source);
  }
  const user = renderScopeUserMarkdown(agentId);
  if (readIfPlain(scopeDir, 'USER.md') !== user) {
    replaceFile(scopeDir, 'USER.md', user);
  }
  return scopeDir;
}

/** Erases the scope's memory, notes and transcripts. */
export function eraseScopeWorkspace(agentId: string, scopeId: string): void {
  // rmSync removes a link itself, never the directory it points to.
  fs.rmSync(scopeWorkspaceDir(agentId, scopeId), {
    recursive: true,
    force: true,
  });
}
