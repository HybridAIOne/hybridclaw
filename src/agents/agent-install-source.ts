import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { CLAW_ARCHIVE_MAX_COMPRESSED_BYTES } from './claw-security.js';

const OFFICIAL_CLAWS_REPO = 'HybridAIOne/claws';
const OFFICIAL_CLAWS_REF = 'main';

export interface ResolvedInstallArchive {
  archivePath: string;
  cleanup?: () => void;
}

interface OfficialClawsSource {
  repo: string;
  ref: string;
  selector: string;
}

function normalizeOfficialClawSelector(
  value: string,
  sourceLabel: string,
): string {
  const selector = value.trim();
  if (!selector) {
    throw new Error(`Missing agent selector for ${sourceLabel}.`);
  }
  if (selector.endsWith('.claw')) {
    throw new Error(
      `${sourceLabel} must point to an agent directory, not a packaged .claw file.`,
    );
  }
  return selector;
}

function githubApiHeaders(url: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!url.startsWith('https://api.github.com/')) {
    return headers;
  }
  const token =
    process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || '';
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: githubApiHeaders(url),
  });
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

async function downloadArchive(url: string): Promise<ResolvedInstallArchive> {
  const response = await fetch(url, {
    headers: githubApiHeaders(url),
  });
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: HTTP ${response.status}`);
  }
  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = Number.parseInt(contentLengthHeader || '', 10);
  if (
    Number.isFinite(contentLength) &&
    contentLength > CLAW_ARCHIVE_MAX_COMPRESSED_BYTES
  ) {
    throw new Error(
      `Archive download exceeds the ${CLAW_ARCHIVE_MAX_COMPRESSED_BYTES} byte limit.`,
    );
  }
  if (!response.body) {
    throw new Error(`Response body was empty for ${url}.`);
  }
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-agent-install-'),
  );
  const fileName =
    path.basename(new URL(url).pathname).trim() || 'agent-package.claw';
  const archivePath = path.join(tempDir, fileName);
  let totalBytes = 0;
  try {
    await pipeline(
      Readable.fromWeb(response.body as NodeReadableStream),
      new Transform({
        transform(chunk, _encoding, callback) {
          totalBytes += Buffer.byteLength(chunk);
          if (totalBytes > CLAW_ARCHIVE_MAX_COMPRESSED_BYTES) {
            callback(
              new Error(
                `Archive download exceeds the ${CLAW_ARCHIVE_MAX_COMPRESSED_BYTES} byte limit.`,
              ),
            );
            return;
          }
          callback(null, chunk);
        },
      }),
      fs.createWriteStream(archivePath, { mode: 0o644 }),
    );
    return {
      archivePath,
      cleanup: () => {
        fs.rmSync(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function parseOfficialClawsSource(
  rawValue: string,
): OfficialClawsSource | null {
  const raw = rawValue.trim();
  if (!raw) return null;

  if (raw.startsWith('official:')) {
    const selector = normalizeOfficialClawSelector(
      raw.slice('official:'.length),
      '`official:<agent-dir>` install source',
    );
    return {
      repo: OFFICIAL_CLAWS_REPO,
      ref: OFFICIAL_CLAWS_REF,
      selector,
    };
  }

  if (!raw.startsWith('github:')) {
    return null;
  }

  const spec = raw.slice('github:'.length).trim();
  const segments = spec.split('/').filter(Boolean);
  if (segments.length !== 3 && segments.length !== 4) {
    throw new Error(
      'GitHub install source must look like `github:owner/repo/<agent-dir>` or `github:owner/repo/<ref>/<agent-dir>`.',
    );
  }
  const repo = `${segments[0]}/${segments[1]}`;
  if (segments.length === 3) {
    return {
      repo,
      ref: OFFICIAL_CLAWS_REF,
      selector: normalizeOfficialClawSelector(
        segments[2],
        '`github:owner/repo/<agent-dir>` install source',
      ),
    };
  }
  return {
    repo,
    ref: segments[2],
    selector: normalizeOfficialClawSelector(
      segments[3],
      '`github:owner/repo/<ref>/<agent-dir>` install source',
    ),
  };
}

async function resolveOfficialClawDirName(
  repo: string,
  ref: string,
  selector: string,
): Promise<string> {
  const normalizedSelector = selector.trim().replace(/\.claw$/i, '');
  if (!normalizedSelector) {
    throw new Error('Agent selector cannot be empty.');
  }

  const directories = await fetchJson<unknown>(
    `https://api.github.com/repos/${repo}/contents/src?ref=${encodeURIComponent(ref)}`,
  );
  const directoryEntries: Array<{ name?: unknown; type?: unknown }> =
    Array.isArray(directories) ? directories : [];
  const dirNames = directoryEntries
    .filter((entry) => entry.type === 'dir' && typeof entry.name === 'string')
    .map((entry) => String(entry.name).trim())
    .filter(Boolean);
  if (dirNames.length === 0) {
    throw new Error(
      `No packaged agent directories were found under ${repo}@${ref} src/. The repository contents may be empty or malformed.`,
    );
  }

  if (dirNames.includes(normalizedSelector)) {
    return normalizedSelector;
  }

  throw new Error(
    `Could not find packaged agent directory "${normalizedSelector}" in ${repo}@${ref}. Use the exact src directory name or an explicit dist/<file>.claw path.`,
  );
}

function parseGitHubArchiveUrl(rawValue: string): string | null {
  const raw = rawValue.trim();
  if (!/^https?:\/\//.test(raw)) return null;
  const url = new URL(raw);
  const pathname = url.pathname.replace(/^\/+/, '');

  if (
    url.hostname === 'raw.githubusercontent.com' &&
    pathname.endsWith('.claw')
  ) {
    return url.toString();
  }

  if (
    url.hostname === 'github.com' &&
    pathname.includes('/blob/') &&
    pathname.endsWith('.claw')
  ) {
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length >= 5 && segments[2] === 'blob') {
      const repo = `${segments[0]}/${segments[1]}`;
      const ref = segments[3];
      const filePath = segments.slice(4).join('/');
      return `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${filePath}`;
    }
  }

  return null;
}

function parseDirectArchiveUrl(rawValue: string): string | null {
  const raw = rawValue.trim();
  if (!/^https?:\/\//.test(raw)) return null;

  const githubUrl = parseGitHubArchiveUrl(raw);
  if (githubUrl) {
    return githubUrl;
  }

  const url = new URL(raw);
  if (url.pathname.endsWith('.claw')) {
    return url.toString();
  }

  throw new Error(
    `Install source URL must point to a .claw archive: ${url.toString()}`,
  );
}

export function isLocalFilesystemInstallSource(
  rawArchivePath: string,
): boolean {
  const raw = rawArchivePath.trim();
  if (!raw) return false;
  try {
    if (parseDirectArchiveUrl(raw)) return false;
    return parseOfficialClawsSource(raw) == null;
  } catch {
    return false;
  }
}

export async function resolveInstallArchiveSource(
  rawArchivePath: string,
): Promise<ResolvedInstallArchive> {
  const directUrl = parseDirectArchiveUrl(rawArchivePath);
  if (directUrl) {
    return downloadArchive(directUrl);
  }

  const official = parseOfficialClawsSource(rawArchivePath);
  if (!official) {
    return { archivePath: path.resolve(rawArchivePath) };
  }

  const selector = official.selector.trim();
  const dirName = await resolveOfficialClawDirName(
    official.repo,
    official.ref,
    selector,
  );
  return downloadArchive(
    `https://raw.githubusercontent.com/${official.repo}/${encodeURIComponent(official.ref)}/dist/${dirName}.claw`,
  );
}
