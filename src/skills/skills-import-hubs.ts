import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { safeExtractZip } from '../agents/claw-security.js';
import {
  type GitHubSkillImportSource,
  normalizeImportedSkillRelativePath,
  populateFromGitHubSource,
  resolveGitHubSkillPathByName,
} from './skills-import-github.js';

const CLAWHUB_API_BASE_URL =
  process.env.CLAWHUB_API_BASE_URL?.trim().replace(/\/+$/, '') ||
  'https://clawhub.ai/api/v1';
const KNOWN_CLAUDE_MARKETPLACES = [
  'anthropics/skills',
  'aiskillstore/marketplace',
];
const MAX_IMPORT_FILE_COUNT = 256;
const MAX_IMPORT_TOTAL_BYTES = 5 * 1024 * 1024;

interface ImportState {
  fileCount: number;
  totalBytes: number;
}

interface WellKnownSkillEntry {
  name?: unknown;
  files?: unknown;
}

interface WellKnownIndexResponse {
  skills?: unknown;
}

interface ClawHubVersionMetadata {
  version?: unknown;
}

interface ClawHubSkillMetadata {
  skill?: unknown;
  latestVersion?: unknown;
}

interface ClaudeMarketplacePlugin {
  name?: unknown;
  source?: unknown;
  skills?: unknown;
}

interface ClaudeMarketplaceManifest {
  name?: unknown;
  plugins?: unknown;
}

export interface SkillsShSkillImportSource {
  kind: 'skills-sh';
  displaySource: string;
  owner: string;
  repo: string;
  slug: string;
  pageUrl: string;
}

export interface WellKnownSkillImportSource {
  kind: 'well-known';
  displaySource: string;
  baseUrl: string;
  explicitSkillName: string | null;
}

export interface ClawHubSkillImportSource {
  kind: 'clawhub';
  displaySource: string;
  slug: string;
}

export interface LobeHubSkillImportSource {
  kind: 'lobehub';
  displaySource: string;
  agentId: string;
}

export interface ClaudeMarketplaceSkillImportSource {
  kind: 'claude-marketplace';
  displaySource: string;
  requestedName: string;
  pluginName: string | null;
  marketplaceName: string | null;
}

export type HubSkillImportSource =
  | SkillsShSkillImportSource
  | WellKnownSkillImportSource
  | ClawHubSkillImportSource
  | LobeHubSkillImportSource
  | ClaudeMarketplaceSkillImportSource;

class SkillImportError extends Error {}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

function normalizeRepoPath(value: string): string {
  return trimSlashes(value).replace(/\/+/g, '/');
}

function ensureText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function resolveRelativeUrl(baseUrl: string, relativePath: string): string {
  return new URL(relativePath, baseUrl).toString();
}

async function fetchResponse(
  fetchImpl: typeof fetch,
  input: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(input, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SkillImportError(`Request failed for ${input}: ${message}`);
  }
}

async function fetchJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetchResponse(fetchImpl, url, init);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new SkillImportError(
      `Request failed for ${url}: HTTP ${response.status}${detail ? ` ${detail.trim()}` : ''}`,
    );
  }
  return (await response.json()) as T;
}

async function fetchText(
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<string> {
  const response = await fetchResponse(fetchImpl, url, init);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new SkillImportError(
      `Request failed for ${url}: HTTP ${response.status}${detail ? ` ${detail.trim()}` : ''}`,
    );
  }
  return await response.text();
}

async function downloadBytes(
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<Uint8Array> {
  const response = await fetchResponse(fetchImpl, url, init);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new SkillImportError(
      `Request failed for ${url}: HTTP ${response.status}${detail ? ` ${detail.trim()}` : ''}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
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

function recordImportedFile(state: ImportState, bytes: number): void {
  if (state.fileCount + 1 > MAX_IMPORT_FILE_COUNT) {
    throw new SkillImportError(
      `Remote skill exceeds the ${MAX_IMPORT_FILE_COUNT}-file import limit.`,
    );
  }
  if (state.totalBytes + bytes > MAX_IMPORT_TOTAL_BYTES) {
    throw new SkillImportError(
      `Remote skill exceeds the ${MAX_IMPORT_TOTAL_BYTES} byte import limit.`,
    );
  }
  state.fileCount += 1;
  state.totalBytes += bytes;
}

function writeImportedFile(
  rootDir: string,
  relativePath: string,
  bytes: Uint8Array,
  state: ImportState,
): void {
  const normalizedRelativePath =
    normalizeImportedSkillRelativePath(relativePath);
  assertSafeRelativePath(normalizedRelativePath);
  recordImportedFile(state, bytes.byteLength);
  const targetPath = path.join(rootDir, normalizedRelativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, Buffer.from(bytes));
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function normalizeWellKnownFiles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
}

async function populateFromWellKnownSource(
  fetchImpl: typeof fetch,
  source: WellKnownSkillImportSource,
  targetDir: string,
): Promise<string> {
  const index = await fetchJson<WellKnownIndexResponse>(
    fetchImpl,
    resolveRelativeUrl(source.baseUrl, '.well-known/skills/index.json'),
  );
  const skills = Array.isArray(index.skills)
    ? (index.skills as WellKnownSkillEntry[])
    : [];
  if (skills.length === 0) {
    throw new SkillImportError(`No skills were listed by ${source.baseUrl}.`);
  }

  const explicitName = source.explicitSkillName?.trim() || '';
  const selectedSkill =
    skills.find((skill) => ensureText(skill.name) === explicitName) ||
    (skills.length === 1 ? skills[0] : null);
  if (!selectedSkill) {
    const availableNames = skills
      .map((skill) => ensureText(skill.name))
      .filter(Boolean)
      .join(', ');
    throw new SkillImportError(
      `Well-known source ${source.baseUrl} exposes multiple skills. Choose one with well-known:${source.baseUrl}.well-known/skills/<name>. Available skills: ${availableNames}`,
    );
  }

  const skillName = ensureText(selectedSkill.name);
  if (!skillName) {
    throw new SkillImportError(
      `Well-known source ${source.baseUrl} returned a skill without a name.`,
    );
  }

  const files = normalizeWellKnownFiles(selectedSkill.files);
  if (files.length === 0) {
    throw new SkillImportError(
      `Well-known skill ${skillName} does not list any files.`,
    );
  }

  const state: ImportState = { fileCount: 0, totalBytes: 0 };
  for (const file of files) {
    assertSafeRelativePath(file);
    const fileUrl = resolveRelativeUrl(
      source.baseUrl,
      `.well-known/skills/${encodeURIComponent(skillName)}/${file}`,
    );
    const bytes = await downloadBytes(fetchImpl, fileUrl);
    writeImportedFile(targetDir, file, bytes, state);
  }

  return `${source.baseUrl}.well-known/skills/${skillName}`;
}

async function populateFromSkillsShSource(
  fetchImpl: typeof fetch,
  source: SkillsShSkillImportSource,
  targetDir: string,
): Promise<string> {
  try {
    await populateFromGitHubSource(
      fetchImpl,
      {
        kind: 'github',
        displaySource: source.displaySource,
        owner: source.owner,
        repo: source.repo,
        ref: null,
        requestedPath: source.slug,
      },
      targetDir,
    );
    return source.pageUrl;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith('No SKILL.md was found in')
    ) {
      throw error;
    }
  }

  const resolvedPath = await resolveGitHubSkillPathByName(fetchImpl, {
    owner: source.owner,
    repo: source.repo,
    requestedName: path.basename(source.slug),
    searchRoots: ['skills', '.agents/skills', '.claude/skills'],
  });
  if (!resolvedPath) {
    throw new SkillImportError(
      `No skill matching "${source.slug}" was found in ${source.owner}/${source.repo}.`,
    );
  }

  await populateFromGitHubSource(
    fetchImpl,
    {
      kind: 'github',
      displaySource: source.displaySource,
      owner: source.owner,
      repo: source.repo,
      ref: resolvedPath.ref,
      requestedPath: resolvedPath.requestedPath,
    },
    targetDir,
  );
  return source.pageUrl;
}

function getClawHubLatestVersion(data: unknown): string {
  const value = data as ClawHubSkillMetadata;
  const latestVersion = value.latestVersion;
  if (
    latestVersion &&
    typeof latestVersion === 'object' &&
    'version' in latestVersion
  ) {
    const resolved = ensureText(
      (latestVersion as ClawHubVersionMetadata).version,
    );
    if (resolved) return resolved;
  }

  const nestedSkill = value.skill;
  if (nestedSkill && typeof nestedSkill === 'object') {
    return getClawHubLatestVersion(nestedSkill);
  }

  throw new SkillImportError('ClawHub skill has no installable version.');
}

function resolveSkillManifestPath(rootDir: string): string | null {
  for (const candidate of ['SKILL.md', 'skill.md']) {
    const candidatePath = path.join(rootDir, candidate);
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
      return candidatePath;
    }
  }
  return null;
}

function flattenSingleSkillRoot(rootDir: string): void {
  if (resolveSkillManifestPath(rootDir)) return;

  const entries = fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  if (entries.length !== 1) return;

  const nestedDir = path.join(rootDir, entries[0].name);
  if (!resolveSkillManifestPath(nestedDir)) return;

  const flattenedDir = `${rootDir}.flatten-${randomUUID().slice(0, 8)}`;
  fs.renameSync(nestedDir, flattenedDir);
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.renameSync(flattenedDir, rootDir);
}

async function populateFromClawHubSource(
  fetchImpl: typeof fetch,
  source: ClawHubSkillImportSource,
  targetDir: string,
): Promise<string> {
  const detail = await fetchJson<unknown>(
    fetchImpl,
    `${CLAWHUB_API_BASE_URL}/skills/${encodeURIComponent(source.slug)}`,
  );
  const version = getClawHubLatestVersion(detail);
  const archiveBytes = await downloadBytes(
    fetchImpl,
    `${CLAWHUB_API_BASE_URL}/download?slug=${encodeURIComponent(source.slug)}&version=${encodeURIComponent(version)}`,
  );

  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-clawhub-import-'),
  );
  const archivePath = path.join(tempRoot, 'skill.zip');

  try {
    fs.writeFileSync(archivePath, Buffer.from(archiveBytes));
    await safeExtractZip(archivePath, targetDir);
    flattenSingleSkillRoot(targetDir);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  return `https://clawhub.ai/skills/${source.slug}`;
}

function convertLobeHubAgentToSkillMarkdown(
  agentData: Record<string, unknown>,
): string {
  const meta =
    agentData.meta && typeof agentData.meta === 'object'
      ? (agentData.meta as Record<string, unknown>)
      : agentData;
  const identifier = ensureText(agentData.identifier) || 'lobehub-agent';
  const title = ensureText(meta.title) || identifier;
  const description = ensureText(meta.description);
  const tags = Array.isArray(meta.tags)
    ? meta.tags.map((tag) => ensureText(tag)).filter(Boolean)
    : [];
  const config =
    agentData.config && typeof agentData.config === 'object'
      ? (agentData.config as Record<string, unknown>)
      : {};
  const systemRole = ensureText(config.systemRole);

  const frontmatter = [
    '---',
    `name: ${yamlString(identifier)}`,
    `description: ${yamlString(description.slice(0, 500))}`,
    'metadata:',
    '  lobehub:',
    `    source: ${yamlString('lobehub')}`,
    `    identifier: ${yamlString(identifier)}`,
    `    title: ${yamlString(title)}`,
    `    tags: [${tags.map(yamlString).join(', ')}]`,
    '---',
  ];

  const body = [
    `# ${title}`,
    '',
    description || 'Imported from LobeHub.',
    '',
    '## Instructions',
    '',
    systemRole || '(No system role defined)',
    '',
  ];

  return `${frontmatter.join('\n')}\n\n${body.join('\n')}`;
}

async function populateFromLobeHubSource(
  fetchImpl: typeof fetch,
  source: LobeHubSkillImportSource,
  targetDir: string,
): Promise<string> {
  let agent: Record<string, unknown>;
  try {
    agent = await fetchJson<Record<string, unknown>>(
      fetchImpl,
      `https://chat-agents.lobehub.com/${encodeURIComponent(source.agentId)}.json`,
    );
  } catch (error) {
    if (
      error instanceof SkillImportError &&
      error.message.includes('HTTP 404')
    ) {
      throw new SkillImportError(
        `LobeHub agent "${source.agentId}" was not found. Use a live agent identifier from https://chat-agents.lobehub.com/index.json.`,
      );
    }
    throw error;
  }
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, 'SKILL.md'),
    convertLobeHubAgentToSkillMarkdown(agent),
    'utf-8',
  );
  return `https://chat-agents.lobehub.com/${source.agentId}.json`;
}

function normalizeMarketplaceSourcePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === './') return '';
  if (trimmed.startsWith('./')) {
    return normalizeRepoPath(trimmed.slice(2));
  }
  return normalizeRepoPath(trimmed);
}

function resolveMarketplaceSkillPaths(
  plugin: ClaudeMarketplacePlugin,
): string[] {
  const sourceBase = normalizeMarketplaceSourcePath(ensureText(plugin.source));
  const skills = Array.isArray(plugin.skills)
    ? plugin.skills
        .map((entry) => ensureText(entry))
        .filter(Boolean)
        .map((entry) => {
          if (entry.startsWith('./')) {
            return normalizeRepoPath(
              path.posix.join(sourceBase, entry.slice(2)),
            );
          }
          return normalizeRepoPath(entry);
        })
    : [];
  if (skills.length > 0) {
    return skills;
  }
  if (!sourceBase) {
    return [];
  }
  return [sourceBase];
}

async function fetchRawGitHubJson<T>(
  fetchImpl: typeof fetch,
  repo: string,
  relativePath: string,
): Promise<T | null> {
  let sawNotFound = false;

  for (const ref of ['main', 'master']) {
    const url = `https://raw.githubusercontent.com/${repo}/${ref}/${relativePath}`;
    try {
      const raw = await fetchText(fetchImpl, url);
      return JSON.parse(raw) as T;
    } catch (error) {
      if (
        error instanceof SkillImportError &&
        error.message.includes('HTTP 404')
      ) {
        sawNotFound = true;
        continue;
      }
      if (error instanceof SyntaxError) {
        throw new SkillImportError(`Invalid JSON at ${url}: ${error.message}`);
      }
      throw error;
    }
  }

  if (sawNotFound) {
    return null;
  }

  throw new SkillImportError(
    `Marketplace source ${repo} did not expose ${relativePath}.`,
  );
}

async function resolveClaudeMarketplaceGitHubSource(
  fetchImpl: typeof fetch,
  source: ClaudeMarketplaceSkillImportSource,
): Promise<GitHubSkillImportSource> {
  const matches: Array<{
    repo: string;
    marketplaceName: string;
    requestedPath: string;
  }> = [];

  for (const repo of KNOWN_CLAUDE_MARKETPLACES) {
    const manifest = await fetchRawGitHubJson<ClaudeMarketplaceManifest>(
      fetchImpl,
      repo,
      '.claude-plugin/marketplace.json',
    );
    if (!manifest) {
      continue;
    }
    const marketplaceName = ensureText(manifest.name) || repo;
    if (source.marketplaceName && marketplaceName !== source.marketplaceName) {
      continue;
    }

    const plugins = Array.isArray(manifest.plugins)
      ? (manifest.plugins as ClaudeMarketplacePlugin[])
      : [];
    for (const plugin of plugins) {
      const pluginName = ensureText(plugin.name);
      const skillPaths = resolveMarketplaceSkillPaths(plugin);
      if (source.pluginName && pluginName !== source.pluginName) {
        continue;
      }

      if (!source.pluginName && source.requestedName === pluginName) {
        if (skillPaths.length === 1) {
          matches.push({
            repo,
            marketplaceName,
            requestedPath: skillPaths[0],
          });
          continue;
        }
        if (skillPaths.length > 1) {
          throw new SkillImportError(
            `Claude marketplace plugin "${pluginName}" publishes multiple skills: ${skillPaths
              .map((skillPath) => path.posix.basename(skillPath))
              .join(
                ', ',
              )}. Import one skill with claude-marketplace/${pluginName}/${path.posix.basename(skillPaths[0])}@${marketplaceName}.`,
          );
        }
      }

      for (const skillPath of skillPaths) {
        const basename = path.posix.basename(skillPath);
        if (basename !== source.requestedName) continue;
        matches.push({
          repo,
          marketplaceName,
          requestedPath: skillPath,
        });
      }
    }
  }

  if (matches.length === 0) {
    const scope = source.marketplaceName
      ? ` in marketplace ${source.marketplaceName}`
      : '';
    throw new SkillImportError(
      `No Claude marketplace skill named "${source.requestedName}" was found${scope}.`,
    );
  }
  if (matches.length > 1) {
    throw new SkillImportError(
      `Claude marketplace skill "${source.requestedName}" is ambiguous. Specify a marketplace with claude-marketplace/${source.requestedName}@<marketplace-name>.`,
    );
  }

  const match = matches[0];
  const [owner, repo] = match.repo.split('/');
  if (!owner || !repo) {
    throw new SkillImportError(
      `Invalid Claude marketplace backing repo: ${match.repo}.`,
    );
  }

  return {
    kind: 'github',
    displaySource: source.displaySource,
    owner,
    repo,
    ref: null,
    requestedPath: match.requestedPath,
  };
}

async function populateFromClaudeMarketplaceSource(
  fetchImpl: typeof fetch,
  source: ClaudeMarketplaceSkillImportSource,
  targetDir: string,
): Promise<string> {
  const githubSource = await resolveClaudeMarketplaceGitHubSource(
    fetchImpl,
    source,
  );
  return await populateFromGitHubSource(fetchImpl, githubSource, targetDir);
}

export async function populateFromHubSource(
  fetchImpl: typeof fetch,
  source: HubSkillImportSource,
  targetDir: string,
): Promise<string> {
  switch (source.kind) {
    case 'skills-sh':
      return await populateFromSkillsShSource(fetchImpl, source, targetDir);
    case 'well-known':
      return await populateFromWellKnownSource(fetchImpl, source, targetDir);
    case 'clawhub':
      return await populateFromClawHubSource(fetchImpl, source, targetDir);
    case 'lobehub':
      return await populateFromLobeHubSource(fetchImpl, source, targetDir);
    case 'claude-marketplace':
      return await populateFromClaudeMarketplaceSource(
        fetchImpl,
        source,
        targetDir,
      );
  }
}
