import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-config.js';
import { guardSkillDirectory } from './skills-guard.js';
import {
  resolveManagedCommunitySkillsDir,
  resolvePackagedCommunitySkillsDir,
} from './skills-roots.js';

const GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const SKILLS_SH_HOSTS = new Set(['skills.sh', 'www.skills.sh']);
const MAX_IMPORT_FILE_COUNT = 256;
const MAX_IMPORT_TOTAL_BYTES = 5 * 1024 * 1024;

interface GitHubRepoMetadata {
  default_branch?: unknown;
}

interface GitHubContentsEntry {
  name?: unknown;
  path?: unknown;
  type?: unknown;
  download_url?: unknown;
  content?: unknown;
}

interface GitHubTreeEntry {
  path?: unknown;
  type?: unknown;
}

interface GitHubTreeResponse {
  truncated?: unknown;
  tree?: unknown;
}

interface WellKnownSkillEntry {
  name?: unknown;
  description?: unknown;
  files?: unknown;
}

interface WellKnownIndexResponse {
  skills?: unknown;
}

interface ImportState {
  fileCount: number;
  totalBytes: number;
}

type SkillImportSource =
  | {
      kind: 'packaged-community';
      displaySource: string;
      requestedPath: string;
    }
  | {
      kind: 'github';
      displaySource: string;
      owner: string;
      repo: string;
      requestedPath: string;
      ref: string | null;
    }
  | {
      kind: 'skills-sh';
      displaySource: string;
      pageUrl: string;
    }
  | {
      kind: 'well-known';
      displaySource: string;
      baseUrl: string;
      explicitSkillName: string | null;
    };

export interface SkillImportResult {
  skillName: string;
  skillDir: string;
  source: string;
  resolvedSource: string;
  replacedExisting: boolean;
  filesImported: number;
}

class SkillImportError extends Error {}

class NotFoundError extends SkillImportError {}

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

function normalizeComparableName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

function ensureText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function encodeUrlPath(value: string): string {
  return value
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function resolveRelativeUrl(baseUrl: string, relativePath: string): string {
  return new URL(relativePath, baseUrl).toString();
}

function resolveWellKnownBaseUrl(rawInput: string): {
  baseUrl: string;
  explicitSkillName: string | null;
} {
  const parsed = new URL(rawInput);
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

function parseSkillsShSource(input: string): SkillImportSource | null {
  const trimmed = input.trim();
  if (trimmed.startsWith('skills-sh/')) {
    const slug = normalizeRepoPath(trimmed.slice('skills-sh/'.length));
    if (!slug) {
      throw new SkillImportError(
        'Invalid skills.sh source. Expected skills-sh/<owner>/<repo>/<skill>.',
      );
    }
    return {
      kind: 'skills-sh',
      displaySource: input,
      pageUrl: `https://skills.sh/${slug}`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (!SKILLS_SH_HOSTS.has(parsed.hostname.toLowerCase())) {
    return null;
  }

  const slug = normalizeRepoPath(parsed.pathname);
  if (!slug) {
    throw new SkillImportError(
      'Invalid skills.sh source. Expected https://skills.sh/<owner>/<repo>/<skill>.',
    );
  }
  return {
    kind: 'skills-sh',
    displaySource: input,
    pageUrl: `https://skills.sh/${slug}`,
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

  if (/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return {
      kind: 'packaged-community',
      displaySource: input,
      requestedPath: trimmed,
    };
  }

  return null;
}

function resolveSkillImportSource(input: string): SkillImportSource {
  const trimmed = String(input || '').trim();
  if (!trimmed) {
    throw new SkillImportError(
      'Missing skill source. Use a packaged community skill name, official/<skill-name>, a skills.sh slug, a GitHub repo/path, or a well-known skills URL.',
    );
  }

  const packagedCommunity = parsePackagedCommunitySource(trimmed);
  if (packagedCommunity) return packagedCommunity;

  const skillsSh = parseSkillsShSource(trimmed);
  if (skillsSh) return skillsSh;

  if (trimmed.startsWith('well-known:')) {
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

  const githubUrl = parseGitHubUrl(trimmed);
  if (githubUrl) return githubUrl;

  try {
    const parsed = new URL(trimmed);
    if (!SKILLS_SH_HOSTS.has(parsed.hostname.toLowerCase())) {
      const resolved = resolveWellKnownBaseUrl(trimmed);
      return {
        kind: 'well-known',
        displaySource: input,
        baseUrl: resolved.baseUrl,
        explicitSkillName: resolved.explicitSkillName,
      };
    }
  } catch {
    // fall through
  }

  const shorthand = parseGitHubShorthand(trimmed);
  if (shorthand) return shorthand;

  throw new SkillImportError(
    `Unsupported skill source: ${input}. Use <skill-name>, official/<skill-name>, skills-sh/<owner>/<repo>/<skill>, <owner>/<repo>/<path>, https://github.com/<owner>/<repo>[/path], or well-known:https://example.com/docs.`,
  );
}

function buildGitHubHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'hybridclaw-skill-import',
  };
  const token =
    process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || '';
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
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
    if (response.status === 404) {
      throw new NotFoundError(
        `Remote skill source not found: ${url}${detail ? ` (${detail.trim()})` : ''}`,
      );
    }
    throw new SkillImportError(
      `Request failed for ${url}: HTTP ${response.status}${detail ? ` ${detail.trim()}` : ''}`,
    );
  }
  return (await response.json()) as T;
}

async function downloadBytes(
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<Uint8Array> {
  const response = await fetchResponse(fetchImpl, url, init);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    if (response.status === 404) {
      throw new NotFoundError(
        `Remote skill file not found: ${url}${detail ? ` (${detail.trim()})` : ''}`,
      );
    }
    throw new SkillImportError(
      `Request failed for ${url}: HTTP ${response.status}${detail ? ` ${detail.trim()}` : ''}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

function ensureImportBudget(state: ImportState, bytes: number): void {
  state.fileCount += 1;
  state.totalBytes += bytes;
  if (state.fileCount > MAX_IMPORT_FILE_COUNT) {
    throw new SkillImportError(
      `Remote skill exceeds the ${MAX_IMPORT_FILE_COUNT}-file import limit.`,
    );
  }
  if (state.totalBytes > MAX_IMPORT_TOTAL_BYTES) {
    throw new SkillImportError(
      `Remote skill exceeds the ${MAX_IMPORT_TOTAL_BYTES} byte import limit.`,
    );
  }
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

function writeImportedFile(
  rootDir: string,
  relativePath: string,
  bytes: Uint8Array,
  state: ImportState,
): void {
  assertSafeRelativePath(relativePath);
  ensureImportBudget(state, bytes.byteLength);
  const targetPath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, Buffer.from(bytes));
}

function normalizeSkillManifestFile(rootDir: string): void {
  const skillFile = path.join(rootDir, 'SKILL.md');
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

async function fetchGitHubRepoMetadata(
  fetchImpl: typeof fetch,
  owner: string,
  repo: string,
): Promise<GitHubRepoMetadata> {
  return await fetchJson<GitHubRepoMetadata>(
    fetchImpl,
    `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    {
      headers: buildGitHubHeaders(),
    },
  );
}

async function fetchGitHubContents(
  fetchImpl: typeof fetch,
  owner: string,
  repo: string,
  repoPath: string,
  ref: string,
): Promise<GitHubContentsEntry | GitHubContentsEntry[]> {
  const encodedPath = repoPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const pathSuffix = encodedPath ? `/${encodedPath}` : '';
  const url = `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${pathSuffix}?ref=${encodeURIComponent(ref)}`;
  return await fetchJson<GitHubContentsEntry | GitHubContentsEntry[]>(
    fetchImpl,
    url,
    {
      headers: buildGitHubHeaders(),
    },
  );
}

async function fetchGitHubTree(
  fetchImpl: typeof fetch,
  owner: string,
  repo: string,
  ref: string,
): Promise<GitHubTreeResponse> {
  return await fetchJson<GitHubTreeResponse>(
    fetchImpl,
    `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    {
      headers: buildGitHubHeaders(),
    },
  );
}

async function findGitHubSkillPathByName(
  fetchImpl: typeof fetch,
  owner: string,
  repo: string,
  ref: string,
  requestedName: string,
): Promise<string | null> {
  const tree = await fetchGitHubTree(fetchImpl, owner, repo, ref);
  const entries = Array.isArray(tree.tree) ? tree.tree : [];
  if (tree.truncated) {
    throw new SkillImportError(
      `GitHub skill search for ${owner}/${repo} returned a truncated tree.`,
    );
  }

  const candidates = entries.filter((entry): entry is GitHubTreeEntry => {
    const entryPath = ensureText(entry.path);
    const entryType = ensureText(entry.type);
    return entryType === 'blob' && /(^|\/)skill\.md$/i.test(entryPath);
  });

  const normalizedRequestedName = normalizeComparableName(requestedName);
  for (const candidate of candidates) {
    const candidatePath = ensureText(candidate.path);
    if (!candidatePath) continue;
    const contents = await fetchGitHubContents(
      fetchImpl,
      owner,
      repo,
      candidatePath,
      ref,
    );
    if (Array.isArray(contents)) continue;
    const fileName = ensureText(contents.name);
    if (!/^skill\.md$/i.test(fileName)) continue;

    const rawBase64 = ensureText(contents.content).replace(/\n/g, '').trim();
    if (!rawBase64) continue;
    const decoded = Buffer.from(rawBase64, 'base64').toString('utf-8');
    const skillName = readSkillNameFromContent(
      decoded,
      path.basename(path.dirname(candidatePath)),
    );
    if (normalizeComparableName(skillName) === normalizedRequestedName) {
      return normalizeRepoPath(path.dirname(candidatePath));
    }
  }

  return null;
}

function buildGitHubPathCandidates(requestedPath: string): string[] {
  const normalized = normalizeRepoPath(requestedPath);
  if (!normalized) return [''];
  const candidates = new Set<string>([normalized]);
  if (!normalized.startsWith('skills/')) {
    candidates.add(`skills/${normalized}`);
  }
  if (!/\/skill\.md$/i.test(normalized)) {
    candidates.add(`${normalized}/SKILL.md`);
    candidates.add(`${normalized}/skill.md`);
    if (!normalized.startsWith('skills/')) {
      candidates.add(`skills/${normalized}/SKILL.md`);
      candidates.add(`skills/${normalized}/skill.md`);
    }
  }
  return Array.from(candidates);
}

async function downloadGitHubPath(
  fetchImpl: typeof fetch,
  owner: string,
  repo: string,
  repoPath: string,
  ref: string,
  targetDir: string,
  state: ImportState,
  requireSkillManifest: boolean,
): Promise<void> {
  const contents = await fetchGitHubContents(
    fetchImpl,
    owner,
    repo,
    repoPath,
    ref,
  );
  if (!Array.isArray(contents)) {
    const name = ensureText(contents.name);
    const entryType = ensureText(contents.type);
    if (entryType !== 'file' || !/^skill\.md$/i.test(name)) {
      throw new NotFoundError(
        `GitHub path ${owner}/${repo}/${repoPath || '.'} is not a skill file.`,
      );
    }
    const downloadUrl = ensureText(contents.download_url);
    if (!downloadUrl) {
      throw new SkillImportError(
        `GitHub file ${owner}/${repo}/${repoPath} does not expose a download URL.`,
      );
    }
    const bytes = await downloadBytes(fetchImpl, downloadUrl);
    writeImportedFile(targetDir, 'SKILL.md', bytes, state);
    return;
  }

  if (requireSkillManifest) {
    const hasTopLevelSkillFile = contents.some((entry) => {
      const entryType = ensureText(entry.type);
      const entryName = ensureText(entry.name);
      return entryType === 'file' && /^skill\.md$/i.test(entryName);
    });
    if (!hasTopLevelSkillFile) {
      throw new NotFoundError(
        `GitHub path ${owner}/${repo}/${repoPath || '.'} is not a skill directory.`,
      );
    }
  }

  for (const entry of contents) {
    const entryType = ensureText(entry.type);
    const entryPath = ensureText(entry.path);
    if (!entryType || !entryPath) continue;

    const prefix = normalizeRepoPath(repoPath);
    const relativePath = prefix
      ? entryPath.startsWith(`${prefix}/`)
        ? entryPath.slice(prefix.length + 1)
        : entryPath
      : entryPath;
    if (!relativePath) continue;

    if (entryType === 'dir') {
      await downloadGitHubPath(
        fetchImpl,
        owner,
        repo,
        entryPath,
        ref,
        path.join(targetDir, path.basename(entryPath)),
        state,
        false,
      );
      continue;
    }

    if (entryType !== 'file') {
      throw new SkillImportError(
        `GitHub skill import does not support ${entryType} entries (${entryPath}).`,
      );
    }

    const downloadUrl = ensureText(entry.download_url);
    if (!downloadUrl) {
      throw new SkillImportError(
        `GitHub file ${owner}/${repo}/${entryPath} does not expose a download URL.`,
      );
    }
    const bytes = await downloadBytes(fetchImpl, downloadUrl);
    const normalizedRelativePath =
      relativePath.toLowerCase() === 'skill.md' ? 'SKILL.md' : relativePath;
    writeImportedFile(targetDir, normalizedRelativePath, bytes, state);
  }
}

async function populateFromGitHubSource(
  fetchImpl: typeof fetch,
  source: SkillImportSource & { kind: 'github' },
  targetDir: string,
): Promise<string> {
  const repoMetadata = await fetchGitHubRepoMetadata(
    fetchImpl,
    source.owner,
    source.repo,
  );
  const ref = source.ref || ensureText(repoMetadata.default_branch) || 'main';
  const candidatePaths = buildGitHubPathCandidates(source.requestedPath);

  for (const candidatePath of candidatePaths) {
    const state: ImportState = { fileCount: 0, totalBytes: 0 };
    try {
      await downloadGitHubPath(
        fetchImpl,
        source.owner,
        source.repo,
        candidatePath,
        ref,
        targetDir,
        state,
        true,
      );
      return `https://github.com/${source.owner}/${source.repo}${candidatePath ? `/tree/${ref}/${candidatePath}` : ''}`;
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        throw error;
      }
    }
  }

  const aliasTarget = source.requestedPath
    ? normalizeRepoPath(path.basename(source.requestedPath))
    : '';
  if (!aliasTarget) {
    throw new SkillImportError(
      `No SKILL.md was found in ${source.owner}/${source.repo}. Use a repo path like ${source.owner}/${source.repo}/skills/<skill-name>.`,
    );
  }

  const aliasPath = await findGitHubSkillPathByName(
    fetchImpl,
    source.owner,
    source.repo,
    ref,
    aliasTarget,
  );
  if (!aliasPath) {
    throw new SkillImportError(
      `No skill matching "${aliasTarget}" was found in ${source.owner}/${source.repo}.`,
    );
  }

  const aliasState: ImportState = { fileCount: 0, totalBytes: 0 };
  await downloadGitHubPath(
    fetchImpl,
    source.owner,
    source.repo,
    aliasPath,
    ref,
    targetDir,
    aliasState,
    true,
  );
  return `https://github.com/${source.owner}/${source.repo}/tree/${ref}/${aliasPath}`;
}

function extractSkillsShInstallCommand(html: string): {
  owner: string;
  repo: string;
  skillName: string;
} {
  const commandMatch = html.match(
    /npx skills add (?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?(?:[^<\n]*?) --skill ([A-Za-z0-9_.-]+)/i,
  );
  if (!commandMatch) {
    throw new SkillImportError(
      'Unable to resolve the skills.sh install command for this skill.',
    );
  }

  const owner = commandMatch[1]?.trim() || '';
  const repo = commandMatch[2]?.trim() || '';
  const skillName = commandMatch[3]?.trim() || '';
  if (!owner || !repo || !skillName) {
    throw new SkillImportError(
      'skills.sh returned an incomplete install command for this skill.',
    );
  }
  return { owner, repo, skillName };
}

async function populateFromSkillsShSource(
  fetchImpl: typeof fetch,
  source: SkillImportSource & { kind: 'skills-sh' },
  targetDir: string,
): Promise<string> {
  const response = await fetchResponse(fetchImpl, source.pageUrl);
  if (!response.ok) {
    if (response.status === 404) {
      throw new NotFoundError(
        `skills.sh skill not found: ${source.displaySource}`,
      );
    }
    throw new SkillImportError(
      `skills.sh request failed for ${source.pageUrl}: HTTP ${response.status}`,
    );
  }
  const html = await response.text();
  const installCommand = extractSkillsShInstallCommand(html);
  return await populateFromGitHubSource(
    fetchImpl,
    {
      kind: 'github',
      displaySource: source.displaySource,
      owner: installCommand.owner,
      repo: installCommand.repo,
      ref: null,
      requestedPath: installCommand.skillName,
    },
    targetDir,
  );
}

function normalizeWellKnownFiles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
}

async function populateFromWellKnownSource(
  fetchImpl: typeof fetch,
  source: SkillImportSource & { kind: 'well-known' },
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
    const encodedFilePath = encodeUrlPath(file);
    const fileUrl = resolveRelativeUrl(
      source.baseUrl,
      `.well-known/skills/${encodeURIComponent(skillName)}/${encodedFilePath}`,
    );
    const bytes = await downloadBytes(fetchImpl, fileUrl);
    const normalizedRelativePath =
      file.toLowerCase() === 'skill.md' ? 'SKILL.md' : file;
    writeImportedFile(targetDir, normalizedRelativePath, bytes, state);
  }

  return `${source.baseUrl}.well-known/skills/${skillName}`;
}

function copyDirectoryContents(sourceDir: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir)) {
    fs.cpSync(path.join(sourceDir, entry), path.join(targetDir, entry), {
      recursive: true,
      force: true,
      dereference: true,
    });
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

export async function importSkill(
  source: string,
  options: {
    homeDir?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<SkillImportResult> {
  const resolvedSource = resolveSkillImportSource(source);
  const fetchImpl = options.fetchImpl ?? fetch;
  const homeDir = options.homeDir ?? DEFAULT_RUNTIME_HOME_DIR;
  const communityRoot = resolveManagedCommunitySkillsDir(homeDir);
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-skill-import-'),
  );
  const tempSkillDir = path.join(tempRoot, 'skill');
  let stageDir = '';
  fs.mkdirSync(tempSkillDir, { recursive: true });

  try {
    let resolvedRemoteSource = resolvedSource.displaySource;
    if (resolvedSource.kind === 'packaged-community') {
      resolvedRemoteSource = populateFromPackagedCommunitySource(
        resolvedSource,
        tempSkillDir,
      );
    } else if (resolvedSource.kind === 'github') {
      resolvedRemoteSource = await populateFromGitHubSource(
        fetchImpl,
        resolvedSource,
        tempSkillDir,
      );
    } else if (resolvedSource.kind === 'skills-sh') {
      resolvedRemoteSource = await populateFromSkillsShSource(
        fetchImpl,
        resolvedSource,
        tempSkillDir,
      );
    } else {
      resolvedRemoteSource = await populateFromWellKnownSource(
        fetchImpl,
        resolvedSource,
        tempSkillDir,
      );
    }

    normalizeSkillManifestFile(tempSkillDir);
    const skillFilePath = path.join(tempSkillDir, 'SKILL.md');
    if (!fs.existsSync(skillFilePath)) {
      throw new SkillImportError(
        `Imported source ${source} did not provide a SKILL.md file.`,
      );
    }

    const skillName = readSkillNameFromFile(skillFilePath);
    const guardDecision = guardSkillDirectory({
      skillName,
      skillPath: tempSkillDir,
      sourceTag: 'community',
    });
    if (!guardDecision.allowed) {
      throw new SkillImportError(
        `Imported skill "${skillName}" was blocked by the security scanner: ${guardDecision.reason}.`,
      );
    }

    const targetDirName = sanitizeInstalledSkillDirName(skillName);
    const targetDir = path.join(communityRoot, targetDirName);
    stageDir = path.join(
      communityRoot,
      `.${targetDirName}.import-${randomUUID().slice(0, 8)}`,
    );
    fs.mkdirSync(communityRoot, { recursive: true });
    copyDirectoryContents(tempSkillDir, stageDir);
    const replacedExisting = fs.existsSync(targetDir);
    if (replacedExisting) {
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
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (stageDir) {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
  }
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
