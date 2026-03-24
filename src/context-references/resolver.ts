import { execFile } from 'node:child_process';
import type { Stats } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ContextReference } from './parser.js';
import {
  isBinaryFile,
  isSensitiveFile,
  resolveAndValidatePath,
} from './security.js';

const MAX_FOLDER_ENTRIES = 200;
const GIT_MAX_BUFFER = 2 * 1024 * 1024;
const URL_FETCH_TIMEOUT_MS = 10_000;
const URL_FETCH_MAX_BYTES = 512 * 1024;

export type ContextReferenceUrlFetcher = (url: string) => Promise<string>;

export interface ExpandReferenceOptions {
  allowedRoot?: string;
  urlFetcher?: ContextReferenceUrlFetcher;
}

type ResolvedContextPath =
  | {
      resolvedPath: string;
      realPath: string;
      pathStats: Stats;
    }
  | { warning: string };

function formatWarning(ref: ContextReference, reason: string): string {
  return `${ref.raw}: ${reason}`;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function displayPath(rootPath: string, targetPath: string): string {
  const relativePath = path.relative(rootPath, targetPath);
  if (!relativePath) return '.';
  return relativePath.split(path.sep).join('/');
}

function formatFencedBlock(
  title: string,
  content: string,
  language: string,
): string {
  const body = content.trimEnd();
  return `${title}\n\`\`\`${language}\n${body}\n\`\`\``;
}

function normalizeFileLanguage(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath);

  switch (extension) {
    case '.bash':
    case '.sh':
    case '.zsh':
      return 'bash';
    case '.cjs':
    case '.js':
    case '.mjs':
      return 'js';
    case '.css':
      return 'css';
    case '.diff':
    case '.patch':
      return 'diff';
    case '.html':
      return 'html';
    case '.json':
    case '.jsonl':
      return 'json';
    case '.md':
      return 'md';
    case '.py':
      return 'python';
    case '.sql':
      return 'sql';
    case '.toml':
      return 'toml';
    case '.ts':
    case '.tsx':
    case '.mts':
      return 'ts';
    case '.xml':
      return 'xml';
    case '.yaml':
    case '.yml':
      return 'yaml';
    default:
      break;
  }

  if (basename === 'Dockerfile') return 'dockerfile';
  if (basename === 'Makefile') return 'make';
  return '';
}

export function codeFenceLanguage(filePath: string): string {
  return normalizeFileLanguage(filePath);
}

async function execFileText(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    encoding?: BufferEncoding;
    maxBuffer?: number;
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        const failure = error as Error & { stdout?: string; stderr?: string };
        failure.stdout = typeof stdout === 'string' ? stdout : '';
        failure.stderr = typeof stderr === 'string' ? stderr : '';
        reject(failure);
        return;
      }

      resolve({
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
      });
    });
  });
}

async function runGitCommand(cwd: string, args: string[]): Promise<string> {
  const result = await execFileText('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
  });
  return (result.stdout || '').trim();
}

async function listFolderEntriesWithRipgrep(folderPath: string): Promise<{
  entries: string[];
  truncated: boolean;
}> {
  const result = await execFileText('rg', ['--files', '.'], {
    cwd: folderPath,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
  });
  const entries = (result.stdout || '')
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  return {
    entries: entries.slice(0, MAX_FOLDER_ENTRIES),
    truncated: entries.length > MAX_FOLDER_ENTRIES,
  };
}

async function listFolderEntriesRecursive(folderPath: string): Promise<{
  entries: string[];
  truncated: boolean;
}> {
  const entries: string[] = [];
  let truncated = false;

  async function walk(currentPath: string, prefix = ''): Promise<void> {
    if (entries.length >= MAX_FOLDER_ENTRIES) {
      truncated = true;
      return;
    }

    const children = await readdir(currentPath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      const childRelative = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.isDirectory()) {
        await walk(path.join(currentPath, child.name), childRelative);
      } else {
        entries.push(childRelative);
      }

      if (entries.length >= MAX_FOLDER_ENTRIES) {
        truncated = true;
        return;
      }
    }
  }

  await walk(folderPath);
  return { entries, truncated };
}

async function listFolderEntries(folderPath: string): Promise<{
  entries: string[];
  truncated: boolean;
}> {
  try {
    return await listFolderEntriesWithRipgrep(folderPath);
  } catch {
    return listFolderEntriesRecursive(folderPath);
  }
}

async function readResponseTextLimited(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = Number.parseInt(contentLengthHeader || '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`response body exceeds ${maxBytes} bytes`);
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`response body exceeds ${maxBytes} bytes`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;

      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error(`response body exceeds ${maxBytes} bytes`);
      }

      text += decoder.decode(chunk.value, { stream: true });
    }

    return `${text}${decoder.decode()}`;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

async function resolveContextPath(
  ref: ContextReference,
  cwd: string,
  allowedRoot: string,
): Promise<ResolvedContextPath> {
  const targetLabel = ref.kind === 'folder' ? 'folder' : 'file';
  const sensitiveLabel = ref.kind === 'folder' ? 'folders' : 'files';

  let resolvedPath: string;
  try {
    resolvedPath = await resolveAndValidatePath(
      cwd,
      ref.path || '',
      allowedRoot,
    );
  } catch {
    return {
      warning: formatWarning(ref, 'path escapes the allowed root'),
    };
  }

  const pathStats = await stat(resolvedPath).catch(() => null);
  if (!pathStats) {
    return {
      warning: formatWarning(ref, `${targetLabel} not found`),
    };
  }

  const realPath = await realpath(resolvedPath).catch(() => resolvedPath);
  if (isSensitiveFile(realPath)) {
    return {
      warning: formatWarning(
        ref,
        `access to sensitive ${sensitiveLabel} is blocked`,
      ),
    };
  }

  return {
    resolvedPath,
    realPath,
    pathStats,
  };
}

async function defaultUrlFetcher(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
    ) {
      throw new Error(`URL fetch timed out after ${URL_FETCH_TIMEOUT_MS}ms`);
    }
    throw error;
  }

  if (
    response.type === 'opaqueredirect' ||
    response.status === 301 ||
    response.status === 302 ||
    response.status === 303 ||
    response.status === 307 ||
    response.status === 308
  ) {
    throw new Error('redirects are blocked for URL references');
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return readResponseTextLimited(response, URL_FETCH_MAX_BYTES);
}

export async function expandFileReference(
  ref: ContextReference,
  cwd: string,
  options: ExpandReferenceOptions,
): Promise<[string | null, string | null]> {
  if (!ref.path) {
    return [formatWarning(ref, 'invalid file reference'), null];
  }

  const allowedRoot = options.allowedRoot ?? cwd;
  const resolved = await resolveContextPath(ref, cwd, allowedRoot);
  if ('warning' in resolved) {
    return [resolved.warning, null];
  }

  if (!resolved.pathStats.isFile()) {
    return [formatWarning(ref, 'target is not a file'), null];
  }

  if (await isBinaryFile(resolved.realPath)) {
    return [formatWarning(ref, 'binary files cannot be injected'), null];
  }

  const fileText = await readFile(resolved.realPath, 'utf8');
  let body = fileText;
  let title = `File: ${displayPath(allowedRoot, resolved.resolvedPath)}`;

  if (typeof ref.lineStart === 'number') {
    const lines = fileText.split(/\r?\n/u);
    if (ref.lineStart > lines.length) {
      return [
        formatWarning(ref, 'requested line range is outside the file'),
        null,
      ];
    }
    const lineEnd = Math.min(ref.lineEnd ?? ref.lineStart, lines.length);
    body = lines.slice(ref.lineStart - 1, lineEnd).join('\n');
    title = `${title}:${ref.lineStart}-${lineEnd}`;
  }

  return [
    null,
    formatFencedBlock(title, body, codeFenceLanguage(resolved.resolvedPath)),
  ];
}

export async function expandFolderReference(
  ref: ContextReference,
  cwd: string,
  options: ExpandReferenceOptions,
): Promise<[string | null, string | null]> {
  if (!ref.path) {
    return [formatWarning(ref, 'invalid folder reference'), null];
  }

  const allowedRoot = options.allowedRoot ?? cwd;
  const resolved = await resolveContextPath(ref, cwd, allowedRoot);
  if ('warning' in resolved) {
    return [resolved.warning, null];
  }

  if (!resolved.pathStats.isDirectory()) {
    return [formatWarning(ref, 'target is not a folder'), null];
  }

  const listing = await listFolderEntries(resolved.realPath);
  const lines = listing.entries.length > 0 ? listing.entries : ['(empty)'];
  if (listing.truncated) {
    lines.push(`... (${MAX_FOLDER_ENTRIES} entries max)`);
  }

  return [
    null,
    formatFencedBlock(
      `Folder: ${displayPath(allowedRoot, resolved.resolvedPath)}`,
      lines.join('\n'),
      'text',
    ),
  ];
}

export async function expandGitReference(
  ref: ContextReference,
  cwd: string,
): Promise<[string | null, string | null]> {
  try {
    let output = '';
    let title = 'Git Diff';

    if (ref.kind === 'diff') {
      output = await runGitCommand(cwd, ['diff', '--no-ext-diff']);
    } else if (ref.kind === 'staged') {
      title = 'Git Staged Diff';
      output = await runGitCommand(cwd, ['diff', '--staged', '--no-ext-diff']);
    } else {
      const requestedCount =
        typeof ref.commitCount === 'number' && Number.isFinite(ref.commitCount)
          ? ref.commitCount
          : Number.NaN;
      if (!Number.isFinite(requestedCount)) {
        return [formatWarning(ref, 'expected @git:<count>'), null];
      }
      const commitCount = Math.max(1, Math.min(10, Math.trunc(requestedCount)));
      title = `Git Log (${commitCount} commit${commitCount === 1 ? '' : 's'})`;
      output = await runGitCommand(cwd, [
        'log',
        `-${commitCount}`,
        '-p',
        '--no-ext-diff',
      ]);
    }

    if (!output) {
      return [formatWarning(ref, 'no git output was available'), null];
    }
    return [null, formatFencedBlock(title, output, 'diff')];
  } catch (error) {
    const message = toErrorMessage(error, 'git command failed');
    return [formatWarning(ref, message), null];
  }
}

export async function expandUrlReference(
  ref: ContextReference,
  options: ExpandReferenceOptions,
): Promise<[string | null, string | null]> {
  const rawUrl = ref.url ?? ref.value ?? '';
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return [formatWarning(ref, 'invalid URL'), null];
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return [formatWarning(ref, 'only http and https URLs are supported'), null];
  }

  const fetcher = options.urlFetcher ?? defaultUrlFetcher;
  try {
    const body = await fetcher(parsedUrl.toString());
    const language = codeFenceLanguage(parsedUrl.pathname);
    return [
      null,
      formatFencedBlock(`URL: ${parsedUrl.toString()}`, body, language),
    ];
  } catch (error) {
    const message = toErrorMessage(error, 'failed to fetch URL');
    return [formatWarning(ref, message), null];
  }
}

export async function expandReference(
  ref: ContextReference,
  cwd: string,
  options: ExpandReferenceOptions = {},
): Promise<[string | null, string | null]> {
  switch (ref.kind) {
    case 'file':
      return expandFileReference(ref, cwd, options);
    case 'folder':
      return expandFolderReference(ref, cwd, options);
    case 'diff':
    case 'git':
    case 'staged':
      return expandGitReference(ref, cwd);
    case 'url':
      return expandUrlReference(ref, options);
    default:
      return [formatWarning(ref, 'unsupported reference type'), null];
  }
}
