import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';

import * as yauzl from 'yauzl';
import { SkillImportError, SkillImportNotFoundError } from './skill-errors.js';
import {
  assertImportBudget,
  ensureText,
  type ImportState,
  MAX_IMPORT_TOTAL_BYTES,
  normalizeRepoPath,
  readResponseBytesWithinImportBudget,
  writeImportedFile,
} from './skill-import-commons.js';

const GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_ARCHIVE_MAX_BYTES = 100 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 512 * 1024;

interface GitHubRepoMetadata {
  default_branch?: unknown;
}

interface GitHubContentsEntry {
  name?: unknown;
  path?: unknown;
  type?: unknown;
  download_url?: unknown;
}

interface GitHubArchiveEntryInfo {
  archivePath: string;
  relativePath: string;
  isDirectory: boolean;
  isSymlink: boolean;
  uncompressedSize: number;
}

interface GitHubArchiveSelection {
  candidatePath: string;
  kind: 'file' | 'dir';
  relativePath: string;
}

export interface GitHubSkillImportSource {
  kind: 'github';
  displaySource: string;
  owner: string;
  repo: string;
  requestedPath: string;
  ref: string | null;
}

export interface GitHubSkillPathResolution {
  ref: string;
  requestedPath: string;
}

function normalizeComparableName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

function encodeUrlPath(value: string): string {
  return value
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function isGitHubApiUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'api.github.com';
  } catch {
    return false;
  }
}

function buildGitHubHeaders(url: string): HeadersInit {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'hybridclaw-skill-import',
  };
  const token =
    process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || '';
  if (token && isGitHubApiUrl(url)) {
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

async function throwForStatus(
  response: Response,
  url: string,
  notFoundPrefix: string,
): Promise<never> {
  const detail = await response.text().catch(() => '');
  if (response.status === 404) {
    throw new SkillImportNotFoundError(
      `${notFoundPrefix}: ${url}${detail ? ` (${detail.trim()})` : ''}`,
    );
  }
  throw new SkillImportError(
    `Request failed for ${url}: HTTP ${response.status}${detail ? ` ${detail.trim()}` : ''}`,
  );
}

async function fetchJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetchResponse(fetchImpl, url, init);
  if (!response.ok) {
    await throwForStatus(response, url, 'Remote skill source not found');
  }
  return (await response.json()) as T;
}

function parseContentLength(response: Response): number | null {
  const raw = response.headers.get('content-length')?.trim() || '';
  if (!raw) return null;

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

async function downloadBytes(
  fetchImpl: typeof fetch,
  url: string,
  state: ImportState,
  init?: RequestInit,
): Promise<Uint8Array> {
  const response = await fetchResponse(fetchImpl, url, init);
  if (!response.ok) {
    await throwForStatus(response, url, 'Remote skill file not found');
  }

  const contentLength = parseContentLength(response);
  assertImportBudget(state, contentLength ?? 0);
  return await readResponseBytesWithinImportBudget(response, state);
}

async function downloadArchiveBytes(
  fetchImpl: typeof fetch,
  url: string,
): Promise<Uint8Array> {
  const response = await fetchResponse(fetchImpl, url, {
    headers: buildGitHubHeaders(url),
  });
  if (!response.ok) {
    await throwForStatus(response, url, 'Remote skill archive not found');
  }

  const contentLength = parseContentLength(response);
  if (contentLength != null && contentLength > GITHUB_ARCHIVE_MAX_BYTES) {
    throw new SkillImportError(
      `GitHub archive exceeds the ${GITHUB_ARCHIVE_MAX_BYTES} byte download limit.`,
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > GITHUB_ARCHIVE_MAX_BYTES) {
    throw new SkillImportError(
      `GitHub archive exceeds the ${GITHUB_ARCHIVE_MAX_BYTES} byte download limit.`,
    );
  }
  return bytes;
}

async function fetchGitHubRepoMetadata(
  fetchImpl: typeof fetch,
  owner: string,
  repo: string,
): Promise<GitHubRepoMetadata> {
  const url = `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return await fetchJson<GitHubRepoMetadata>(fetchImpl, url, {
    headers: buildGitHubHeaders(url),
  });
}

async function fetchGitHubContents(
  fetchImpl: typeof fetch,
  owner: string,
  repo: string,
  repoPath: string,
  ref: string,
): Promise<GitHubContentsEntry | GitHubContentsEntry[]> {
  const encodedPath = encodeUrlPath(repoPath);
  const pathSuffix = encodedPath ? `/${encodedPath}` : '';
  const url = `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${pathSuffix}?ref=${encodeURIComponent(ref)}`;
  return await fetchJson<GitHubContentsEntry | GitHubContentsEntry[]>(
    fetchImpl,
    url,
    {
      headers: buildGitHubHeaders(url),
    },
  );
}

function isSkillManifestEntry(entry: GitHubContentsEntry): boolean {
  const entryType = ensureText(entry.type);
  const entryName = ensureText(entry.name);
  return entryType === 'file' && /^skill\.md$/i.test(entryName);
}

function buildGitHubPathCandidates(requestedPath: string): string[] {
  const normalized = normalizeRepoPath(requestedPath);
  if (!normalized) return [];

  const candidates = [normalized];
  const isBareSkillName =
    !normalized.includes('/') && !/^skill\.md$/i.test(normalized);
  if (isBareSkillName && !normalized.startsWith('skills/')) {
    candidates.push(`skills/${normalized}`);
  }

  return candidates;
}

function formatTriedGitHubPaths(
  owner: string,
  repo: string,
  candidatePaths: string[],
): string {
  return candidatePaths
    .map((candidate) => `${owner}/${repo}/${candidate}`)
    .join(', ');
}

async function downloadGitHubFile(
  fetchImpl: typeof fetch,
  owner: string,
  repo: string,
  entry: GitHubContentsEntry,
  targetDir: string,
  relativePath: string,
  state: ImportState,
): Promise<void> {
  const entryPath = ensureText(entry.path);
  const downloadUrl = ensureText(entry.download_url);
  if (!downloadUrl) {
    throw new SkillImportError(
      `GitHub file ${owner}/${repo}/${entryPath} does not expose a download URL.`,
    );
  }

  const bytes = await downloadBytes(fetchImpl, downloadUrl, state);
  writeImportedFile(targetDir, relativePath, bytes, state);
}

async function downloadGitHubDirectory(
  fetchImpl: typeof fetch,
  owner: string,
  repo: string,
  repoPath: string,
  ref: string,
  targetDir: string,
  entries: GitHubContentsEntry[],
  state: ImportState,
  requireSkillManifest: boolean,
): Promise<void> {
  if (requireSkillManifest && !entries.some(isSkillManifestEntry)) {
    throw new SkillImportNotFoundError(
      `GitHub path ${owner}/${repo}/${repoPath || '.'} is not a skill directory.`,
    );
  }

  const prefix = normalizeRepoPath(repoPath);
  for (const entry of entries) {
    const entryType = ensureText(entry.type);
    const entryPath = ensureText(entry.path);
    if (!entryType || !entryPath) continue;

    const relativePath = prefix
      ? entryPath.startsWith(`${prefix}/`)
        ? entryPath.slice(prefix.length + 1)
        : entryPath
      : entryPath;
    if (!relativePath) continue;

    if (entryType === 'dir') {
      const childEntries = await fetchGitHubContents(
        fetchImpl,
        owner,
        repo,
        entryPath,
        ref,
      );
      if (!Array.isArray(childEntries)) {
        throw new SkillImportError(
          `GitHub directory ${owner}/${repo}/${entryPath} did not return a directory listing.`,
        );
      }

      await downloadGitHubDirectory(
        fetchImpl,
        owner,
        repo,
        entryPath,
        ref,
        path.join(targetDir, path.basename(entryPath)),
        childEntries,
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

    await downloadGitHubFile(
      fetchImpl,
      owner,
      repo,
      entry,
      targetDir,
      relativePath,
      state,
    );
  }
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
    if (!isSkillManifestEntry(contents)) {
      throw new SkillImportNotFoundError(
        `GitHub path ${owner}/${repo}/${repoPath || '.'} is not a skill file.`,
      );
    }

    await downloadGitHubFile(
      fetchImpl,
      owner,
      repo,
      contents,
      targetDir,
      'SKILL.md',
      state,
    );
    return;
  }

  await downloadGitHubDirectory(
    fetchImpl,
    owner,
    repo,
    repoPath,
    ref,
    targetDir,
    contents,
    state,
    requireSkillManifest,
  );
}

function resolveGitHubPathUrl(
  owner: string,
  repo: string,
  ref: string,
  repoPath: string,
): string {
  return `https://github.com/${owner}/${repo}/tree/${ref}/${repoPath}`;
}

async function populateFromGitHubApiCandidates(
  fetchImpl: typeof fetch,
  owner: string,
  repo: string,
  ref: string,
  targetDir: string,
  candidatePaths: string[],
): Promise<string | null> {
  const state: ImportState = { fileCount: 0, totalBytes: 0 };

  for (const candidatePath of candidatePaths) {
    try {
      await downloadGitHubPath(
        fetchImpl,
        owner,
        repo,
        candidatePath,
        ref,
        targetDir,
        state,
        true,
      );
      return resolveGitHubPathUrl(owner, repo, ref, candidatePath);
    } catch (error) {
      if (!(error instanceof SkillImportNotFoundError)) {
        throw error;
      }
    }
  }

  return null;
}

function buildRefCandidates(
  requestedRef: string | null,
  defaultBranch: string,
): string[] {
  const candidates = [requestedRef, defaultBranch, 'main', 'master']
    .map((entry) => ensureText(entry).trim())
    .filter(Boolean);
  return Array.from(new Set(candidates));
}

function isGitHubRateLimitError(error: unknown): boolean {
  return error instanceof Error && /rate limit exceeded/i.test(error.message);
}

function resolveGitHubArchiveUrl(
  owner: string,
  repo: string,
  ref: string,
): string {
  return `https://codeload.github.com/${owner}/${repo}/zip/${encodeURIComponent(ref)}`;
}

function openZipFile(archivePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      archivePath,
      {
        lazyEntries: true,
        autoClose: false,
      },
      (error, zipFile) => {
        if (error) {
          reject(error);
          return;
        }
        if (!zipFile) {
          reject(new Error(`Failed to open ZIP archive at ${archivePath}.`));
          return;
        }
        resolve(zipFile);
      },
    );
  });
}

function openZipEntryReadStream(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      if (!stream) {
        reject(
          new Error(
            `Failed to read ZIP entry "${entry.fileName || '<unknown>'}".`,
          ),
        );
        return;
      }
      resolve(stream);
    });
  });
}

function closeZipFile(zipFile: yauzl.ZipFile): void {
  try {
    zipFile.close();
  } catch {
    // best effort
  }
}

function getZipEntryMode(entry: yauzl.Entry): number | null {
  const mode = entry.externalFileAttributes >>> 16;
  return mode > 0 ? mode : null;
}

function isZipEntrySymlink(entry: yauzl.Entry): boolean {
  const mode = getZipEntryMode(entry);
  return mode != null && (mode & 0o170000) === 0o120000;
}

function validateArchiveEntryName(entryName: string): string {
  const normalized = String(entryName || '').replace(/\\/g, '/');
  if (!normalized) {
    throw new Error('ZIP archive contains an empty entry path.');
  }
  if (normalized.includes('\0')) {
    throw new Error(`ZIP entry "${normalized}" contains a null byte.`);
  }
  if (normalized.startsWith('/')) {
    throw new Error(`ZIP entry "${normalized}" uses an absolute path.`);
  }
  if (/^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`ZIP entry "${normalized}" uses an absolute drive path.`);
  }

  const trimmed = normalized.endsWith('/')
    ? normalized.slice(0, -1)
    : normalized;
  if (!trimmed) {
    return normalized;
  }

  for (const segment of trimmed.split('/')) {
    if (!segment || segment === '.' || segment === '..') {
      throw new Error(
        `ZIP entry "${normalized}" escapes the output directory.`,
      );
    }
  }
  return normalized;
}

function toArchiveRelativePath(entryName: string): string {
  const normalized = validateArchiveEntryName(entryName);
  const trimmed = normalized.endsWith('/')
    ? normalized.slice(0, -1)
    : normalized;
  const parts = trimmed.split('/').filter(Boolean);
  if (parts.length <= 1) {
    return '';
  }
  return parts.slice(1).join('/');
}

function isSkillManifestPath(relativePath: string): boolean {
  return /^skill\.md$/i.test(path.posix.basename(relativePath));
}

async function withGitHubArchiveFile<T>(
  fetchImpl: typeof fetch,
  owner: string,
  repo: string,
  ref: string,
  callback: (archivePath: string) => Promise<T> | T,
): Promise<T> {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-github-archive-'),
  );
  const archivePath = path.join(tempRoot, 'repo.zip');

  try {
    const archiveUrl = resolveGitHubArchiveUrl(owner, repo, ref);
    const bytes = await downloadArchiveBytes(fetchImpl, archiveUrl);
    fs.writeFileSync(archivePath, Buffer.from(bytes));
    return await callback(archivePath);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function listGitHubArchiveEntries(
  archivePath: string,
): Promise<GitHubArchiveEntryInfo[]> {
  const zipFile = await openZipFile(archivePath);

  return await new Promise<GitHubArchiveEntryInfo[]>((resolve, reject) => {
    const entries: GitHubArchiveEntryInfo[] = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      closeZipFile(zipFile);
      resolve(entries);
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      closeZipFile(zipFile);
      reject(error);
    };

    zipFile.on('error', fail);
    zipFile.on('end', finish);
    zipFile.on('entry', (entry) => {
      try {
        const archivePath = validateArchiveEntryName(entry.fileName);
        entries.push({
          archivePath,
          relativePath: toArchiveRelativePath(archivePath),
          isDirectory: archivePath.endsWith('/'),
          isSymlink: isZipEntrySymlink(entry),
          uncompressedSize: entry.uncompressedSize,
        });
        zipFile.readEntry();
      } catch (error) {
        fail(error);
      }
    });

    zipFile.readEntry();
  });
}

async function readZipEntryBuffer(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
  maxBytes: number,
): Promise<Uint8Array> {
  const stream = await openZipEntryReadStream(zipFile, entry);
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  return await new Promise<Uint8Array>((resolve, reject) => {
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        stream.destroy(
          new Error(
            `ZIP entry "${entry.fileName}" exceeded the ${maxBytes} byte read limit.`,
          ),
        );
        return;
      }
      chunks.push(buffer);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });
  });
}

async function readGitHubArchiveTextEntries(
  archivePath: string,
  wantedArchivePaths: Set<string>,
): Promise<Record<string, string>> {
  const zipFile = await openZipFile(archivePath);

  return await new Promise<Record<string, string>>((resolve, reject) => {
    const textEntries: Record<string, string> = {};
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      closeZipFile(zipFile);
      resolve(textEntries);
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      closeZipFile(zipFile);
      reject(error);
    };

    zipFile.on('error', fail);
    zipFile.on('end', finish);
    zipFile.on('entry', (entry) => {
      try {
        const normalizedArchivePath = validateArchiveEntryName(entry.fileName);
        if (!wantedArchivePaths.has(normalizedArchivePath)) {
          zipFile.readEntry();
          return;
        }
        if (isZipEntrySymlink(entry)) {
          fail(
            new SkillImportError(
              `ZIP entry "${normalizedArchivePath}" is a symlink and is not allowed.`,
            ),
          );
          return;
        }

        void readZipEntryBuffer(zipFile, entry, MAX_MANIFEST_BYTES)
          .then((bytes) => {
            textEntries[normalizedArchivePath] =
              Buffer.from(bytes).toString('utf-8');
            zipFile.readEntry();
          })
          .catch(fail);
      } catch (error) {
        fail(error);
      }
    });

    zipFile.readEntry();
  });
}

function resolveArchiveCandidateImport(
  entries: GitHubArchiveEntryInfo[],
  candidatePaths: string[],
): GitHubArchiveSelection | null {
  for (const candidatePath of candidatePaths) {
    const normalizedCandidate = normalizeRepoPath(candidatePath);
    if (!normalizedCandidate) continue;

    const fileEntry = entries.find(
      (entry) =>
        !entry.isDirectory &&
        entry.relativePath === normalizedCandidate &&
        isSkillManifestPath(entry.relativePath),
    );
    if (fileEntry) {
      return {
        candidatePath: normalizedCandidate,
        kind: 'file',
        relativePath: normalizedCandidate,
      };
    }

    const manifestEntry =
      entries.find(
        (entry) =>
          !entry.isDirectory &&
          entry.relativePath === `${normalizedCandidate}/SKILL.md`,
      ) ??
      entries.find(
        (entry) =>
          !entry.isDirectory &&
          entry.relativePath === `${normalizedCandidate}/skill.md`,
      );
    if (manifestEntry) {
      return {
        candidatePath: normalizedCandidate,
        kind: 'dir',
        relativePath: normalizedCandidate,
      };
    }
  }

  return null;
}

async function extractGitHubArchiveSelection(
  archivePath: string,
  selection: GitHubArchiveSelection,
  targetDir: string,
): Promise<void> {
  const zipFile = await openZipFile(archivePath);

  await new Promise<void>((resolve, reject) => {
    const state: ImportState = { fileCount: 0, totalBytes: 0 };
    let extracted = false;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      closeZipFile(zipFile);
      if (!extracted) {
        reject(
          new SkillImportError(
            `GitHub archive did not contain the requested path ${selection.relativePath}.`,
          ),
        );
        return;
      }
      resolve();
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      closeZipFile(zipFile);
      reject(error);
    };

    zipFile.on('error', fail);
    zipFile.on('end', finish);
    zipFile.on('entry', (entry) => {
      try {
        const normalizedArchivePath = validateArchiveEntryName(entry.fileName);
        const relativePath = toArchiveRelativePath(normalizedArchivePath);
        const wantedRelativePath =
          selection.kind === 'file'
            ? relativePath === selection.relativePath
            : relativePath.startsWith(`${selection.relativePath}/`);
        if (
          !wantedRelativePath ||
          !relativePath ||
          normalizedArchivePath.endsWith('/')
        ) {
          zipFile.readEntry();
          return;
        }
        if (isZipEntrySymlink(entry)) {
          fail(
            new SkillImportError(
              `ZIP entry "${normalizedArchivePath}" is a symlink and is not allowed.`,
            ),
          );
          return;
        }

        const outputRelativePath =
          selection.kind === 'file'
            ? 'SKILL.md'
            : relativePath.slice(selection.relativePath.length + 1);
        if (!outputRelativePath) {
          zipFile.readEntry();
          return;
        }

        void readZipEntryBuffer(zipFile, entry, MAX_IMPORT_TOTAL_BYTES)
          .then((bytes) => {
            writeImportedFile(targetDir, outputRelativePath, bytes, state);
            extracted = true;
            zipFile.readEntry();
          })
          .catch(fail);
      } catch (error) {
        fail(error);
      }
    });

    zipFile.readEntry();
  });
}

async function populateFromGitHubArchive(
  fetchImpl: typeof fetch,
  source: GitHubSkillImportSource,
  targetDir: string,
  ref: string,
  candidatePaths: string[],
): Promise<string | null> {
  try {
    return await withGitHubArchiveFile(
      fetchImpl,
      source.owner,
      source.repo,
      ref,
      async (archivePath) => {
        const entries = await listGitHubArchiveEntries(archivePath);
        const resolved = resolveArchiveCandidateImport(entries, candidatePaths);
        if (!resolved) {
          return null;
        }

        await extractGitHubArchiveSelection(archivePath, resolved, targetDir);
        return resolveGitHubPathUrl(
          source.owner,
          source.repo,
          ref,
          resolved.candidatePath,
        );
      },
    );
  } catch (error) {
    if (error instanceof SkillImportNotFoundError) {
      return null;
    }
    throw error;
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

function matchesArchiveSearchRoot(
  relativePath: string,
  searchRoot: string,
): boolean {
  const normalizedRoot = normalizeRepoPath(searchRoot);
  if (!normalizedRoot) return true;
  return (
    relativePath === normalizedRoot ||
    relativePath.startsWith(`${normalizedRoot}/`)
  );
}

function findGitHubSkillPathByNameInArchive(
  entries: GitHubArchiveEntryInfo[],
  textEntries: Record<string, string>,
  requestedName: string,
  searchRoots: string[],
): string | null {
  const normalizedRequestedName = normalizeComparableName(requestedName);

  for (const entry of entries) {
    if (
      entry.isDirectory ||
      !isSkillManifestPath(entry.relativePath) ||
      !searchRoots.some((searchRoot) =>
        matchesArchiveSearchRoot(entry.relativePath, searchRoot),
      )
    ) {
      continue;
    }

    const raw = textEntries[entry.archivePath];
    if (!raw) continue;

    const skillName = readSkillNameFromContent(
      raw,
      path.posix.basename(path.posix.dirname(entry.relativePath)),
    );
    if (normalizeComparableName(skillName) !== normalizedRequestedName) {
      continue;
    }

    return normalizeRepoPath(path.posix.dirname(entry.relativePath));
  }

  return null;
}

export async function resolveGitHubSkillPathByName(
  fetchImpl: typeof fetch,
  params: {
    owner: string;
    repo: string;
    ref?: string | null;
    requestedName: string;
    searchRoots?: string[];
  },
): Promise<GitHubSkillPathResolution | null> {
  let defaultBranch = '';
  if (!params.ref) {
    try {
      const repoMetadata = await fetchGitHubRepoMetadata(
        fetchImpl,
        params.owner,
        params.repo,
      );
      defaultBranch = ensureText(repoMetadata.default_branch);
    } catch (error) {
      if (!isGitHubRateLimitError(error)) {
        throw error;
      }
    }
  }

  const refCandidates = buildRefCandidates(params.ref ?? null, defaultBranch);
  const searchRoots = params.searchRoots?.length
    ? params.searchRoots
    : ['skills', '.agents/skills', '.claude/skills', ''];

  for (const ref of refCandidates) {
    try {
      const requestedPath = await withGitHubArchiveFile(
        fetchImpl,
        params.owner,
        params.repo,
        ref,
        async (archivePath) => {
          const entries = await listGitHubArchiveEntries(archivePath);
          const manifestEntries = entries.filter(
            (entry) =>
              !entry.isDirectory &&
              isSkillManifestPath(entry.relativePath) &&
              searchRoots.some((searchRoot) =>
                matchesArchiveSearchRoot(entry.relativePath, searchRoot),
              ),
          );
          const textEntries = await readGitHubArchiveTextEntries(
            archivePath,
            new Set(manifestEntries.map((entry) => entry.archivePath)),
          );
          return findGitHubSkillPathByNameInArchive(
            manifestEntries,
            textEntries,
            params.requestedName,
            searchRoots,
          );
        },
      );
      if (requestedPath) {
        return { ref, requestedPath };
      }
    } catch (error) {
      if (error instanceof SkillImportNotFoundError) {
        continue;
      }
      throw error;
    }
  }

  return null;
}

export async function populateFromGitHubSource(
  fetchImpl: typeof fetch,
  source: GitHubSkillImportSource,
  targetDir: string,
): Promise<string> {
  if (!source.requestedPath) {
    throw new SkillImportError(
      `GitHub skill imports require an explicit repo path like ${source.owner}/${source.repo}/skills/<skill-name>.`,
    );
  }

  let defaultBranch = '';
  let apiAvailable = true;
  if (!source.ref) {
    try {
      const repoMetadata = await fetchGitHubRepoMetadata(
        fetchImpl,
        source.owner,
        source.repo,
      );
      defaultBranch = ensureText(repoMetadata.default_branch);
    } catch (error) {
      if (!isGitHubRateLimitError(error)) {
        throw error;
      }
      apiAvailable = false;
    }
  }

  const refCandidates = buildRefCandidates(source.ref, defaultBranch);
  const candidatePaths = buildGitHubPathCandidates(source.requestedPath);

  for (const ref of refCandidates) {
    if (apiAvailable) {
      try {
        const resolvedApiPath = await populateFromGitHubApiCandidates(
          fetchImpl,
          source.owner,
          source.repo,
          ref,
          targetDir,
          candidatePaths,
        );
        if (resolvedApiPath) {
          return resolvedApiPath;
        }
      } catch (error) {
        if (!isGitHubRateLimitError(error)) {
          throw error;
        }
        apiAvailable = false;
      }
    }

    const resolvedArchivePath = await populateFromGitHubArchive(
      fetchImpl,
      source,
      targetDir,
      ref,
      candidatePaths,
    );
    if (resolvedArchivePath) {
      return resolvedArchivePath;
    }
  }

  throw new SkillImportError(
    `No SKILL.md was found in ${source.owner}/${source.repo}. Tried: ${formatTriedGitHubPaths(source.owner, source.repo, candidatePaths)}. Use an explicit skill directory or SKILL.md path.`,
  );
}
