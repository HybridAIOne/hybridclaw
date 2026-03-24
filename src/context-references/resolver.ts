import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ContextReference } from './parser.js';
import {
  isBinaryFile,
  isSensitiveFile,
  resolveAndValidatePath,
} from './security.js';

const MAX_FOLDER_ENTRIES = 200;
const GIT_MAX_BUFFER = 2 * 1024 * 1024;

export type ContextReferenceUrlFetcher = (url: string) => Promise<string>;

export interface ExpandReferenceOptions {
  allowedRoot?: string;
  urlFetcher?: ContextReferenceUrlFetcher;
}

function formatWarning(ref: ContextReference, reason: string): string {
  return `${ref.raw}: ${reason}`;
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

async function defaultUrlFetcher(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
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
  let resolvedPath: string;
  try {
    resolvedPath = resolveAndValidatePath(cwd, ref.path, allowedRoot);
  } catch {
    return [formatWarning(ref, 'path escapes the allowed root'), null];
  }

  if (isSensitiveFile(resolvedPath)) {
    return [formatWarning(ref, 'access to sensitive files is blocked'), null];
  }

  const fileStats = await stat(resolvedPath).catch(() => null);
  if (!fileStats) {
    return [formatWarning(ref, 'file not found'), null];
  }
  if (!fileStats.isFile()) {
    return [formatWarning(ref, 'target is not a file'), null];
  }

  if (await isBinaryFile(resolvedPath)) {
    return [formatWarning(ref, 'binary files cannot be injected'), null];
  }

  const fileText = await readFile(resolvedPath, 'utf8');
  let body = fileText;
  let title = `File: ${displayPath(allowedRoot, resolvedPath)}`;

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
    formatFencedBlock(title, body, codeFenceLanguage(resolvedPath)),
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
  let resolvedPath: string;
  try {
    resolvedPath = resolveAndValidatePath(cwd, ref.path, allowedRoot);
  } catch {
    return [formatWarning(ref, 'path escapes the allowed root'), null];
  }

  if (isSensitiveFile(resolvedPath)) {
    return [formatWarning(ref, 'access to sensitive folders is blocked'), null];
  }

  const folderStats = await stat(resolvedPath).catch(() => null);
  if (!folderStats) {
    return [formatWarning(ref, 'folder not found'), null];
  }
  if (!folderStats.isDirectory()) {
    return [formatWarning(ref, 'target is not a folder'), null];
  }

  const listing = await listFolderEntries(resolvedPath);
  const lines = listing.entries.length > 0 ? listing.entries : ['(empty)'];
  if (listing.truncated) {
    lines.push(`... (${MAX_FOLDER_ENTRIES} entries max)`);
  }

  return [
    null,
    formatFencedBlock(
      `Folder: ${displayPath(allowedRoot, resolvedPath)}`,
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
    const message =
      error instanceof Error && error.message
        ? error.message
        : 'git command failed';
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
    const message =
      error instanceof Error && error.message
        ? error.message
        : 'failed to fetch URL';
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
