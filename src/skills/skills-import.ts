import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import { resolveInstallPath } from '../infra/install-root.js';
import { SkillImportError } from './skill-errors.js';
import type { SkillGuardDecision, SkillGuardVerdict } from './skills-guard.js';
import { guardSkillDirectory } from './skills-guard.js';
import {
  type GitHubSkillImportSource,
  normalizeImportedSkillRelativePath,
  populateFromGitHubSource,
} from './skills-import-github.js';
import {
  type ClaudeMarketplaceSkillImportSource,
  type ClawHubSkillImportSource,
  type HubSkillImportSource,
  type LobeHubSkillImportSource,
  populateFromHubSource,
  type SkillsShSkillImportSource,
  type WellKnownSkillImportSource,
} from './skills-import-hubs.js';

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const SKILLS_SH_HOSTS = new Set(['skills.sh', 'www.skills.sh']);

type LocalSkillImportSource = {
  kind: 'local';
  displaySource: string;
  resolvedPath: string;
  isZip: boolean;
};

type SkillImportSource =
  | {
      kind: 'packaged-community';
      displaySource: string;
      requestedPath: string;
    }
  | LocalSkillImportSource
  | GitHubSkillImportSource
  | HubSkillImportSource;

export interface SkillImportResult {
  skillName: string;
  skillDir: string;
  source: string;
  resolvedSource: string;
  replacedExisting: boolean;
  filesImported: number;
  guardOverrideApplied?: boolean;
  guardSkipped?: boolean;
  guardVerdict?: SkillGuardVerdict;
  guardFindingsCount?: number;
}

export interface ImportSkillOptions {
  homeDir?: string;
  fetchImpl?: typeof fetch;
  force?: boolean;
  installRootDir?: string;
  replaceExisting?: boolean;
  skipGuard?: boolean;
}

function resolveManagedCommunitySkillsDir(
  homeDir = DEFAULT_RUNTIME_HOME_DIR,
): string {
  return path.join(homeDir, 'skills');
}

function resolvePackagedCommunitySkillsDir(): string {
  return resolveInstallPath('community-skills');
}

function sanitizeInstalledSkillDirName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'skill';
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

function normalizeRepoPath(value: string): string {
  return trimSlashes(value).replace(/\/+/g, '/');
}

function assertSafeRelativePath(relativePath: string): void {
  const normalized = relativePath.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/')) {
    throw new SkillImportError(`Unsafe skill file path: ${relativePath}`);
  }

  const parts = normalized.split('/');
  if (
    parts.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    throw new SkillImportError(`Unsafe skill file path: ${relativePath}`);
  }
}

function normalizeSkillManifestFile(rootDir: string): void {
  const skillFile = path.join(
    rootDir,
    normalizeImportedSkillRelativePath('skill.md'),
  );
  if (fs.existsSync(skillFile)) return;

  const lowerCaseSkillFile = path.join(rootDir, 'skill.md');
  if (fs.existsSync(lowerCaseSkillFile)) {
    fs.renameSync(lowerCaseSkillFile, skillFile);
  }
}

function readSkillNameFromContent(raw: string, fallbackName: string): string {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return fallbackName;

  const block = match[1] || '';
  for (const line of block.split('\n')) {
    const metaMatch = line.match(/^name\s*:\s*(.+)$/);
    if (!metaMatch) continue;

    const value = metaMatch[1]?.trim().replace(/^['"]|['"]$/g, '');
    if (value) return value;
  }

  return fallbackName;
}

function readSkillNameFromFile(skillFilePath: string): string {
  const raw = fs.readFileSync(skillFilePath, 'utf-8');
  return readSkillNameFromContent(
    raw,
    path.basename(path.dirname(skillFilePath)),
  );
}

function parseLocalSource(input: string): LocalSkillImportSource | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const isExplicitLocal =
    trimmed.startsWith('/') ||
    trimmed.startsWith('~/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../');

  if (!isExplicitLocal) return null;

  const expanded = trimmed.startsWith('~/')
    ? path.join(os.homedir(), trimmed.slice(2))
    : trimmed;
  const resolved = path.resolve(expanded);

  if (!fs.existsSync(resolved)) {
    throw new SkillImportError(`Local skill source not found: ${resolved}`);
  }

  const stat = fs.statSync(resolved);
  const isZip = stat.isFile() && resolved.endsWith('.zip');

  if (!stat.isDirectory() && !isZip) {
    throw new SkillImportError(
      `Local skill source must be a directory or a .zip file: ${resolved}`,
    );
  }

  return {
    kind: 'local',
    displaySource: input,
    resolvedPath: resolved,
    isZip,
  };
}

async function populateFromLocalSource(
  source: LocalSkillImportSource,
  targetDir: string,
): Promise<string> {
  if (source.isZip) {
    const { safeExtractZip } = await import('../agents/claw-security.js');
    await safeExtractZip(source.resolvedPath, targetDir);
  } else {
    copyDirectoryContents(source.resolvedPath, targetDir);
  }
  return source.resolvedPath;
}

function parseGitHubUrl(input: string): SkillImportSource | null {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }

  if (!GITHUB_HOSTS.has(parsed.hostname.toLowerCase())) {
    return null;
  }

  const parts = trimSlashes(parsed.pathname)
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean);
  if (parts.length < 2) {
    throw new SkillImportError(
      `Unsupported GitHub skill source: ${input}. Expected https://github.com/<owner>/<repo>[/path].`,
    );
  }

  const [owner, repo, ...rest] = parts;
  if (!owner || !repo) {
    throw new SkillImportError(
      `Unsupported GitHub skill source: ${input}. Expected https://github.com/<owner>/<repo>[/path].`,
    );
  }

  if (rest[0] === 'tree' || rest[0] === 'blob') {
    const ref = rest[1] || null;
    return {
      kind: 'github',
      displaySource: input,
      owner,
      repo,
      ref,
      requestedPath: normalizeRepoPath(rest.slice(2).join('/')),
    };
  }

  return {
    kind: 'github',
    displaySource: input,
    owner,
    repo,
    ref: null,
    requestedPath: normalizeRepoPath(rest.join('/')),
  };
}

function parseGitHubShorthand(input: string): SkillImportSource | null {
  const normalized = input.trim().replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/.+)?$/.test(normalized)) {
    return null;
  }

  const [owner, repo, ...rest] = normalized.split('/');
  if (!owner || !repo) return null;

  return {
    kind: 'github',
    displaySource: input,
    owner,
    repo,
    ref: null,
    requestedPath: normalizeRepoPath(rest.join('/')),
  };
}

function parseSkillsShSource(input: string): SkillsShSkillImportSource | null {
  const trimmed = input.trim();
  if (trimmed.startsWith('skills-sh/')) {
    const slug = normalizeRepoPath(trimmed.slice('skills-sh/'.length));
    const [owner, repo, ...rest] = slug.split('/');
    const skillSlug = normalizeRepoPath(rest.join('/'));
    if (!owner || !repo || !skillSlug) {
      throw new SkillImportError(
        'Invalid skills.sh source. Expected skills-sh/<owner>/<repo>/<skill>.',
      );
    }
    return {
      kind: 'skills-sh',
      displaySource: input,
      owner,
      repo,
      slug: skillSlug,
      pageUrl: `https://skills.sh/${owner}/${repo}/${skillSlug}`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== 'https:' ||
    !SKILLS_SH_HOSTS.has(parsed.hostname.toLowerCase())
  ) {
    return null;
  }

  const parts = normalizeRepoPath(parsed.pathname).split('/');
  if (parts.length < 3) {
    throw new SkillImportError(
      'Invalid skills.sh URL. Expected https://skills.sh/<owner>/<repo>/<skill>.',
    );
  }

  const [owner, repo, ...rest] = parts;
  const skillSlug = normalizeRepoPath(rest.join('/'));
  if (!owner || !repo || !skillSlug) {
    throw new SkillImportError(
      'Invalid skills.sh URL. Expected https://skills.sh/<owner>/<repo>/<skill>.',
    );
  }

  return {
    kind: 'skills-sh',
    displaySource: input,
    owner,
    repo,
    slug: skillSlug,
    pageUrl: `https://skills.sh/${owner}/${repo}/${skillSlug}`,
  };
}

function resolveWellKnownBaseUrl(rawInput: string): {
  baseUrl: string;
  explicitSkillName: string | null;
} {
  const parsed = new URL(rawInput);
  if (parsed.protocol !== 'https:') {
    throw new SkillImportError(
      'Invalid well-known source. Expected an HTTPS URL.',
    );
  }

  const marker = '/.well-known/skills/';
  const markerIndex = parsed.pathname.indexOf(marker);
  if (markerIndex < 0) {
    const basePath = trimSlashes(parsed.pathname);
    const normalizedPath = basePath ? `${basePath}/` : '';
    return {
      baseUrl: new URL(`/${normalizedPath}`, parsed.origin).toString(),
      explicitSkillName: null,
    };
  }

  const prefix = parsed.pathname.slice(0, markerIndex);
  const suffix = trimSlashes(
    parsed.pathname.slice(markerIndex + marker.length),
  );
  const parts = suffix.split('/').filter(Boolean);
  const explicitSkillName =
    parts.length > 0 && parts[0] !== 'index.json' ? parts[0] : null;

  return {
    baseUrl: new URL(`${prefix || '/'}/`, parsed.origin).toString(),
    explicitSkillName,
  };
}

function parseWellKnownSource(
  input: string,
): WellKnownSkillImportSource | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('well-known:')) {
    return null;
  }

  const raw = trimmed.slice('well-known:'.length).trim();
  if (!raw) {
    throw new SkillImportError(
      'Invalid well-known source. Expected well-known:https://example.com/docs or a direct /.well-known/skills/... URL.',
    );
  }

  const resolved = resolveWellKnownBaseUrl(raw);
  return {
    kind: 'well-known',
    displaySource: input,
    baseUrl: resolved.baseUrl,
    explicitSkillName: resolved.explicitSkillName,
  };
}

function parseClawHubSource(input: string): ClawHubSkillImportSource | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('clawhub/')) {
    return null;
  }

  const slug = normalizeRepoPath(trimmed.slice('clawhub/'.length));
  if (!slug || slug.includes('/')) {
    throw new SkillImportError(
      'Invalid ClawHub source. Expected clawhub/<skill-slug>.',
    );
  }

  return {
    kind: 'clawhub',
    displaySource: input,
    slug,
  };
}

function parseLobeHubSource(input: string): LobeHubSkillImportSource | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('lobehub/')) {
    return null;
  }

  const agentId = normalizeRepoPath(trimmed.slice('lobehub/'.length));
  if (!agentId || agentId.includes('/')) {
    throw new SkillImportError(
      'Invalid LobeHub source. Expected lobehub/<agent-id>.',
    );
  }

  return {
    kind: 'lobehub',
    displaySource: input,
    agentId,
  };
}

function parseClaudeMarketplaceSource(
  input: string,
): ClaudeMarketplaceSkillImportSource | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('claude-marketplace/')) {
    return null;
  }

  const rawSelector = trimmed.slice('claude-marketplace/'.length).trim();
  if (!rawSelector) {
    throw new SkillImportError(
      'Invalid Claude marketplace source. Expected claude-marketplace/<skill>[@<marketplace>] or claude-marketplace/<plugin>/<skill>[@<marketplace>].',
    );
  }

  const atIndex = rawSelector.lastIndexOf('@');
  const rawPath = atIndex >= 0 ? rawSelector.slice(0, atIndex) : rawSelector;
  const rawMarketplace =
    atIndex >= 0 ? rawSelector.slice(atIndex + 1).trim() : '';
  const parts = normalizeRepoPath(rawPath).split('/').filter(Boolean);
  if (parts.length === 0 || parts.length > 2) {
    throw new SkillImportError(
      'Invalid Claude marketplace source. Expected claude-marketplace/<skill>[@<marketplace>] or claude-marketplace/<plugin>/<skill>[@<marketplace>].',
    );
  }

  return {
    kind: 'claude-marketplace',
    displaySource: input,
    pluginName: parts.length === 2 ? parts[0] : null,
    requestedName: parts.length === 2 ? parts[1] : parts[0],
    marketplaceName: rawMarketplace || null,
  };
}

function parsePackagedCommunitySource(input: string): SkillImportSource | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('official/')) {
    const requestedPath = normalizeRepoPath(trimmed.slice('official/'.length));
    if (!requestedPath) {
      throw new SkillImportError(
        'Invalid official skill source. Expected official/<skill-name>.',
      );
    }

    return {
      kind: 'packaged-community',
      displaySource: input,
      requestedPath,
    };
  }

  return null;
}

function unsupportedSkillSourceMessage(input: string): string {
  return `Unsupported skill source: ${input}. Use a local path (/path/to/skill, ./skill, ~/skill, or /path/to/skill.zip), official/<skill-name>, skills-sh/<owner>/<repo>/<skill>, clawhub/<skill-slug>, lobehub/<agent-id>, claude-marketplace/<skill>[@<marketplace>], well-known:https://example.com/docs, <owner>/<repo>/<path>, or https://github.com/<owner>/<repo>[/path].`;
}

function resolveSkillImportSource(input: string): SkillImportSource {
  const trimmed = String(input || '').trim();
  if (!trimmed) {
    throw new SkillImportError(
      'Missing skill source. Use a local path (/path/to/skill, ./skill, ~/skill, or /path/to/skill.zip), official/<skill-name>, skills-sh/<owner>/<repo>/<skill>, clawhub/<skill-slug>, lobehub/<agent-id>, claude-marketplace/<skill>[@<marketplace>], well-known:https://example.com/docs, <owner>/<repo>/<path>, or https://github.com/<owner>/<repo>[/path].',
    );
  }

  const localSource = parseLocalSource(trimmed);
  if (localSource) return localSource;

  const packagedCommunity = parsePackagedCommunitySource(trimmed);
  if (packagedCommunity) return packagedCommunity;

  const skillsSh = parseSkillsShSource(trimmed);
  if (skillsSh) return skillsSh;

  const clawHub = parseClawHubSource(trimmed);
  if (clawHub) return clawHub;

  const lobeHub = parseLobeHubSource(trimmed);
  if (lobeHub) return lobeHub;

  const claudeMarketplace = parseClaudeMarketplaceSource(trimmed);
  if (claudeMarketplace) return claudeMarketplace;

  const wellKnown = parseWellKnownSource(trimmed);
  if (wellKnown) return wellKnown;

  const githubUrl = parseGitHubUrl(trimmed);
  if (githubUrl) return githubUrl;

  const shorthand = parseGitHubShorthand(trimmed);
  if (shorthand) return shorthand;

  throw new SkillImportError(unsupportedSkillSourceMessage(input));
}

function copyDirectoryContents(sourceDir: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isSymbolicLink()) {
      throw new SkillImportError(
        `Refusing to import symlinked content from ${sourcePath}.`,
      );
    }
    if (entry.isDirectory()) {
      copyDirectoryContents(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile()) {
      throw new SkillImportError(
        `Refusing to import unsupported filesystem entry from ${sourcePath}.`,
      );
    }

    fs.copyFileSync(sourcePath, targetPath);
  }
}

function populateFromPackagedCommunitySource(
  source: SkillImportSource & { kind: 'packaged-community' },
  targetDir: string,
): string {
  const requestedPath = normalizeRepoPath(source.requestedPath);
  if (!requestedPath) {
    throw new SkillImportError(
      `Invalid packaged community skill source: ${source.displaySource}`,
    );
  }

  assertSafeRelativePath(requestedPath);

  const packagedRoot = resolvePackagedCommunitySkillsDir();
  const sourceDir = path.join(packagedRoot, requestedPath);
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new SkillImportError(
      `No packaged community skill matching "${source.displaySource}" was found.`,
    );
  }

  copyDirectoryContents(sourceDir, targetDir);
  return `official/${requestedPath}`;
}

function countFiles(rootDir: string): number {
  let count = 0;
  const pendingDirs = [rootDir];

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    if (!currentDir) continue;

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pendingDirs.push(entryPath);
        continue;
      }
      count += 1;
    }
  }

  return count;
}

export async function importSkill(
  source: string,
  options: ImportSkillOptions = {},
): Promise<SkillImportResult> {
  const resolvedSource = resolveSkillImportSource(source);
  const fetchImpl = options.fetchImpl ?? fetch;
  const homeDir = options.homeDir ?? DEFAULT_RUNTIME_HOME_DIR;
  const installRoot =
    options.installRootDir ?? resolveManagedCommunitySkillsDir(homeDir);
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-skill-import-'),
  );
  const tempSkillDir = path.join(tempRoot, 'skill');
  let stageDir: string | null = null;
  fs.mkdirSync(tempSkillDir, { recursive: true });

  try {
    const resolvedRemoteSource =
      resolvedSource.kind === 'local'
        ? await populateFromLocalSource(resolvedSource, tempSkillDir)
        : resolvedSource.kind === 'packaged-community'
          ? populateFromPackagedCommunitySource(resolvedSource, tempSkillDir)
          : resolvedSource.kind === 'github'
            ? await populateFromGitHubSource(
                fetchImpl,
                resolvedSource,
                tempSkillDir,
              )
            : await populateFromHubSource(
                fetchImpl,
                resolvedSource,
                tempSkillDir,
              );

    normalizeSkillManifestFile(tempSkillDir);
    const skillFilePath = path.join(tempSkillDir, 'SKILL.md');
    if (!fs.existsSync(skillFilePath)) {
      throw new SkillImportError(
        `Imported source ${source} did not provide a SKILL.md file.`,
      );
    }

    const skillName = readSkillNameFromFile(skillFilePath);
    let guardDecision: SkillGuardDecision | null = null;
    let guardVerdict: SkillGuardVerdict | undefined;
    let guardFindingsCount = 0;
    let guardOverrideApplied = false;
    let guardSkipped = false;

    if (!options.skipGuard) {
      guardDecision = guardSkillDirectory({
        skillName,
        skillPath: tempSkillDir,
        sourceTag: 'community',
      });
      guardVerdict = guardDecision.result.verdict;
      guardFindingsCount = guardDecision.result.findings.length;
      guardOverrideApplied =
        options.force === true &&
        !guardDecision.allowed &&
        guardVerdict === 'caution';
      if (!guardDecision.allowed && !guardOverrideApplied) {
        const forceSuffix =
          options.force === true && guardVerdict === 'dangerous'
            ? ' Dangerous verdicts cannot be overridden with --force.'
            : '';
        throw new SkillImportError(
          `Imported skill "${skillName}" was blocked by the security scanner: ${guardDecision.reason}.${forceSuffix}`,
        );
      }
    } else {
      guardSkipped = true;
    }

    const targetDirName = sanitizeInstalledSkillDirName(skillName);
    const targetDir = path.join(installRoot, targetDirName);
    stageDir = path.join(
      installRoot,
      `.${targetDirName}.import-${randomUUID().slice(0, 8)}`,
    );
    fs.mkdirSync(installRoot, { recursive: true });
    copyDirectoryContents(tempSkillDir, stageDir);
    const replacedExisting = fs.existsSync(targetDir);
    if (replacedExisting) {
      if (options.replaceExisting === false) {
        throw new SkillImportError(
          `Imported skill "${skillName}" would overwrite existing content at ${targetDir}.`,
        );
      }
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    fs.renameSync(stageDir, targetDir);

    return {
      skillName,
      skillDir: targetDir,
      source: resolvedSource.displaySource,
      resolvedSource: resolvedRemoteSource,
      replacedExisting,
      filesImported: countFiles(targetDir),
      guardSkipped: guardSkipped || undefined,
      guardOverrideApplied: guardOverrideApplied || undefined,
      guardVerdict,
      guardFindingsCount:
        guardFindingsCount > 0 ? guardFindingsCount : undefined,
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (stageDir !== null) {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
  }
}
