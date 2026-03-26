import fs from 'node:fs';
import path from 'node:path';
import {
  replaceWorkspaceRootInOutput,
  resolveWorkspaceGlobPattern,
  resolveWorkspacePath,
  stripWorkspaceRootPrefix,
  WORKSPACE_ROOT,
} from '../runtime-paths.js';
import type { ToolDefinition } from '../types.js';

const SEARCH_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.hg',
  '.svn',
  '.idea',
  '.vscode',
  '.DS_Store',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.yarn',
  '.pnpm-store',
  'vendor',
  '__pycache__',
  '.tox',
  '.nox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.venv',
  'venv',
  '.eggs',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
]);

const SEARCH_BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.svg',
  '.mp3',
  '.mp4',
  '.avi',
  '.mov',
  '.mkv',
  '.flac',
  '.wav',
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.7z',
  '.rar',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dat',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.pyc',
  '.pyo',
  '.class',
  '.o',
  '.a',
]);

const SEARCH_MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;
const GLOB_SEARCH_MAX_RESULTS = 50;
const GLOB_SEARCH_MAX_FILES_SCANNED = 10_000;
const GLOB_SEARCH_TIMEOUT_MS = 15_000;
const GREP_SEARCH_MAX_MATCHES = 200;
const GREP_SEARCH_MAX_CONTEXT_LINES = 5;
const GREP_SEARCH_MAX_FILES_SCANNED = 10_000;
const GREP_SEARCH_MAX_OUTPUT_CHARS = 50_000;
const GREP_SEARCH_MAX_REGEX_PATTERN_LENGTH = 256;
const GREP_SEARCH_TIMEOUT_MS = 30_000;

type SearchMatcher = (value: string) => boolean;

type GlobToken =
  | { type: 'literal'; value: string }
  | { type: 'alternatives'; values: string[] }
  | { type: 'star' }
  | { type: 'question' }
  | { type: 'globstar' }
  | { type: 'globstar_dir' };

type RegexValidationFrame = {
  hasComplexSubpattern: boolean;
};

type SearchStatus =
  | { kind: 'ok' }
  | { kind: 'timeout' }
  | { kind: 'truncated'; reason: string };

type IncludePatternMatcher = (relativePath: string) => boolean;

type CollectWorkspaceFilesOptions = {
  matcher?: SearchMatcher;
  includePattern?: string;
  maxFilesScanned: number;
  maxResults?: number;
  deadlineAt: number;
  timeoutMs: number;
  textOnly?: boolean;
};

type WalkWorkspaceFilesOptions = {
  deadlineAt: number;
  maxFilesScanned: number;
};

type WorkspaceFileVisitor = (filePath: string) => SearchStatus | null;

export type SearchToolRunResult = {
  output: string;
  isError: boolean;
};

const SEARCH_STATUS_OK: SearchStatus = { kind: 'ok' };
const SEARCH_STATUS_TIMEOUT: SearchStatus = { kind: 'timeout' };

export const SEARCH_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'glob',
      description:
        'List files matching a glob pattern inside the workspace only, with skip-dir protections and truncation guidance. For absolute paths outside the workspace, use bash instead.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description:
              'Glob pattern to match files inside the workspace (relative paths preferred, use ** for recursive matches)',
          },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Search for a fixed string in workspace files, with optional filename filters and context lines. Set regex=true to opt into validated regex mode.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description:
              'Fixed string to search for by default, or a validated regex pattern when regex=true',
          },
          path: {
            type: 'string',
            description: 'Directory or file to search in (default: workspace root)',
          },
          include: {
            type: 'string',
            description:
              'Optional glob filter for filenames or relative paths, for example *.ts or src/**/*.ts',
          },
          context: {
            type: 'number',
            description:
              'Optional number of context lines to include before and after each match (max 5)',
          },
          regex: {
            type: 'boolean',
            description:
              'Optional opt-in for validated regex matching. Leave unset for safer fixed-string search.',
          },
        },
        required: ['pattern'],
      },
    },
  },
];

function readStringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNonNegativeIntegerValue(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function readBooleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return null;
}

function safeJoin(userPath: string): string {
  const resolved = resolveWorkspacePath(userPath);
  if (resolved) return resolved;
  throw new Error(`Path escapes workspace: ${userPath}`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function tokenizeGlobPattern(pattern: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  let literalBuffer = '';

  const flushLiteralBuffer = (): void => {
    if (!literalBuffer) return;
    tokens.push({ type: 'literal', value: literalBuffer });
    literalBuffer = '';
  };

  for (let index = 0; index < pattern.length; index += 1) {
    const ch = pattern[index];
    if (ch === '*') {
      const next = pattern[index + 1];
      const afterNext = pattern[index + 2];
      flushLiteralBuffer();
      if (next === '*') {
        if (afterNext === '/') {
          tokens.push({ type: 'globstar_dir' });
          index += 2;
          continue;
        }
        tokens.push({ type: 'globstar' });
        index += 1;
        continue;
      }
      tokens.push({ type: 'star' });
      continue;
    }
    if (ch === '?') {
      flushLiteralBuffer();
      tokens.push({ type: 'question' });
      continue;
    }
    if (ch === '{') {
      const end = pattern.indexOf('}', index + 1);
      if (end > index) {
        flushLiteralBuffer();
        tokens.push({
          type: 'alternatives',
          values: pattern.slice(index + 1, end).split(','),
        });
        index = end;
        continue;
      }
    }
    literalBuffer += ch;
  }

  flushLiteralBuffer();
  return tokens;
}

function buildGlobMatcher(pattern: string): SearchMatcher {
  const tokens = tokenizeGlobPattern(pattern);

  return (candidate: string): boolean => {
    const memo = new Map<string, boolean>();

    const matches = (tokenIndex: number, valueIndex: number): boolean => {
      const key = `${tokenIndex}:${valueIndex}`;
      const cached = memo.get(key);
      if (cached != null) return cached;

      let result = false;
      const token = tokens[tokenIndex];
      if (!token) {
        result = valueIndex === candidate.length;
      } else if (token.type === 'literal') {
        result =
          candidate.startsWith(token.value, valueIndex) &&
          matches(tokenIndex + 1, valueIndex + token.value.length);
      } else if (token.type === 'alternatives') {
        result = token.values.some(
          (value) =>
            candidate.startsWith(value, valueIndex) &&
            matches(tokenIndex + 1, valueIndex + value.length),
        );
      } else if (token.type === 'question') {
        result =
          valueIndex < candidate.length &&
          candidate[valueIndex] !== '/' &&
          matches(tokenIndex + 1, valueIndex + 1);
      } else if (token.type === 'star') {
        result = matches(tokenIndex + 1, valueIndex);
        for (
          let nextIndex = valueIndex;
          !result &&
          nextIndex < candidate.length &&
          candidate[nextIndex] !== '/';
          nextIndex += 1
        ) {
          result = matches(tokenIndex + 1, nextIndex + 1);
        }
      } else if (token.type === 'globstar') {
        result = matches(tokenIndex + 1, valueIndex);
        for (
          let nextIndex = valueIndex;
          !result && nextIndex < candidate.length;
          nextIndex += 1
        ) {
          result = matches(tokenIndex + 1, nextIndex + 1);
        }
      } else {
        result = matches(tokenIndex + 1, valueIndex);
        let segmentStart = valueIndex;
        while (!result && segmentStart < candidate.length) {
          const slashIndex = candidate.indexOf('/', segmentStart);
          if (slashIndex === -1) break;
          if (slashIndex > segmentStart) {
            result = matches(tokenIndex + 1, slashIndex + 1);
          }
          segmentStart = slashIndex + 1;
        }
      }

      memo.set(key, result);
      return result;
    };

    return matches(0, 0);
  };
}

function validateGrepRegexPattern(pattern: string): string | null {
  if (pattern.length > GREP_SEARCH_MAX_REGEX_PATTERN_LENGTH) {
    return `regex patterns must be at most ${GREP_SEARCH_MAX_REGEX_PATTERN_LENGTH} characters`;
  }

  const groupStack: RegexValidationFrame[] = [];
  let inCharacterClass = false;
  let lastTokenKind:
    | 'none'
    | 'simple'
    | 'quantified'
    | 'group_simple'
    | 'group_complex' = 'none';

  for (let index = 0; index < pattern.length; index += 1) {
    const ch = pattern[index];

    if (ch === '\\') {
      const next = pattern[index + 1];
      if (next == null) break;
      if (!inCharacterClass) {
        if (/\d/.test(next) || next === 'k') {
          return 'backreferences are not supported';
        }
        lastTokenKind = 'simple';
      }
      index += 1;
      continue;
    }

    if (inCharacterClass) {
      if (ch === ']') {
        inCharacterClass = false;
        lastTokenKind = 'simple';
      }
      continue;
    }

    if (ch === '[') {
      inCharacterClass = true;
      continue;
    }

    if (ch === '(') {
      const next = pattern[index + 1];
      if (next === '?') {
        const modifier = pattern[index + 2];
        if (modifier !== ':') {
          return 'lookarounds and other advanced regex groups are not supported';
        }
        index += 2;
      }
      groupStack.push({ hasComplexSubpattern: false });
      lastTokenKind = 'none';
      continue;
    }

    if (ch === ')') {
      const frame = groupStack.pop();
      if (!frame) {
        lastTokenKind = 'simple';
        continue;
      }
      if (frame.hasComplexSubpattern && groupStack.length > 0) {
        groupStack[groupStack.length - 1].hasComplexSubpattern = true;
      }
      lastTokenKind = frame.hasComplexSubpattern ? 'group_complex' : 'group_simple';
      continue;
    }

    if (ch === '|') {
      if (groupStack.length > 0) {
        groupStack[groupStack.length - 1].hasComplexSubpattern = true;
      }
      lastTokenKind = 'none';
      continue;
    }

    const quantifierMatch = pattern.slice(index).match(/^\{(\d+)(,(\d*)?)?\}/);
    const isQuantifier =
      ch === '*' || ch === '+' || ch === '?' || quantifierMatch != null;
    if (isQuantifier) {
      if (
        lastTokenKind === 'quantified' ||
        lastTokenKind === 'group_complex'
      ) {
        return 'nested quantifiers are not supported';
      }
      if (groupStack.length > 0) {
        groupStack[groupStack.length - 1].hasComplexSubpattern = true;
      }
      lastTokenKind = 'quantified';
      if (quantifierMatch) {
        index += quantifierMatch[0].length - 1;
      }
      continue;
    }

    lastTokenKind = 'simple';
  }

  return null;
}

function buildLiteralSubstringMatcher(pattern: string): SearchMatcher {
  return (value: string): boolean => value.includes(pattern);
}

function buildRegexSearchMatcher(pattern: string): SearchMatcher | string {
  const validationError = validateGrepRegexPattern(pattern);
  if (validationError) return validationError;

  try {
    const regex = new RegExp(pattern);
    return (value: string): boolean => {
      regex.lastIndex = 0;
      return regex.test(value);
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `invalid regex pattern: ${message}`;
  }
}

function createTruncatedSearchStatus(reason: string): SearchStatus {
  return { kind: 'truncated', reason };
}

function isSearchDone(status: SearchStatus): boolean {
  return status.kind !== 'ok';
}

function displaySearchPath(filePath: string): string {
  return replaceWorkspaceRootInOutput(filePath.replace(/\\/g, '/'));
}

function hasSearchableTextExtension(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return !SEARCH_BINARY_EXTENSIONS.has(extension);
}

function readSearchableTextFile(filePath: string): string | null {
  if (!hasSearchableTextExtension(filePath)) return null;

  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(SEARCH_MAX_FILE_SIZE_BYTES + 1);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead > SEARCH_MAX_FILE_SIZE_BYTES) return null;
    return buffer.toString('utf-8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close failures on best-effort search reads.
      }
    }
  }
}

function computeSearchDeadline(timeoutMs: number): number {
  return Date.now() + timeoutMs;
}

function buildSearchStatusNote(
  status: SearchStatus,
  toolName: 'glob' | 'grep',
  timeoutMs: number,
): string | null {
  if (status.kind === 'ok') return null;
  if (status.kind === 'timeout') {
    return `${toolName} search timed out after ${Math.floor(timeoutMs / 1000)}s. Try narrowing the search scope.`;
  }
  return `Results truncated due to ${status.reason}. Try narrowing the search scope.`;
}

function formatSearchOutput(
  items: string[],
  emptyMessage: string,
  note: string | null,
): string {
  if (items.length === 0) {
    return note ? `${emptyMessage}\n\n(${note})` : emptyMessage;
  }

  let text = items.join('\n');
  if (note) text += `\n\n(${note})`;
  return text;
}

function appendSearchOutputEntry(
  items: string[],
  item: string,
  totalChars: number,
  maxChars: number,
): number | null {
  const nextTotalChars = totalChars + item.length + 1;
  if (nextTotalChars > maxChars) return null;
  items.push(item);
  return nextTotalChars;
}

function buildIncludePatternMatcher(
  includePattern?: string,
): IncludePatternMatcher | null {
  const normalizedPattern = readStringValue(includePattern)?.replace(
    /^\.\/+/,
    '',
  );
  if (!normalizedPattern) return null;
  const matcher = buildGlobMatcher(normalizedPattern.replace(/\\/g, '/'));
  return (relativePath: string): boolean => {
    const normalizedRelativePath = relativePath.replace(/\\/g, '/');
    const basename = path.posix.basename(normalizedRelativePath);
    if (normalizedPattern.includes('/')) {
      return matcher(normalizedRelativePath);
    }
    return matcher(basename) || matcher(normalizedRelativePath);
  };
}

function resolveGlobSearchRoot(pattern: string): string | null {
  const firstMetaIndex = pattern.search(/[*?[{]/);
  if (firstMetaIndex === -1) return pattern;

  const prefixEnd = pattern.lastIndexOf('/', firstMetaIndex);
  if (prefixEnd <= 0) return WORKSPACE_ROOT;

  const candidate = pattern.slice(0, prefixEnd);
  try {
    const stats = fs.statSync(candidate);
    return stats.isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

function walkWorkspaceFiles(
  searchRoot: string,
  opts: WalkWorkspaceFilesOptions,
  visitFile: WorkspaceFileVisitor,
): SearchStatus {
  let scannedFiles = 0;

  const visitSearchFile = (filePath: string): SearchStatus | null => {
    scannedFiles += 1;
    if (scannedFiles > opts.maxFilesScanned) {
      return createTruncatedSearchStatus(
        `scanned more than ${opts.maxFilesScanned} files`,
      );
    }
    return visitFile(filePath);
  };

  try {
    const stats = fs.statSync(searchRoot);
    if (stats.isFile()) {
      return visitSearchFile(searchRoot) ?? SEARCH_STATUS_OK;
    }
  } catch {
    return SEARCH_STATUS_OK;
  }

  const stack = [searchRoot];
  while (stack.length > 0) {
    if (Date.now() >= opts.deadlineAt) {
      return SEARCH_STATUS_TIMEOUT;
    }

    const currentDir = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Keep traversal deterministic so timeouts and result caps return stable
    // subsets instead of depending on filesystem enumeration order.
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const directoriesToVisit: string[] = [];

    for (const entry of entries) {
      if (Date.now() >= opts.deadlineAt) {
        return SEARCH_STATUS_TIMEOUT;
      }

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!SEARCH_SKIP_DIRS.has(entry.name)) directoriesToVisit.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const status = visitSearchFile(fullPath);
      if (status) return status;
    }

    for (let index = directoriesToVisit.length - 1; index >= 0; index -= 1) {
      stack.push(directoriesToVisit[index]);
    }
  }

  return SEARCH_STATUS_OK;
}

function collectWorkspaceFiles(
  searchRoot: string,
  opts: CollectWorkspaceFilesOptions,
): {
  files: string[];
  status: SearchStatus;
} {
  const files: string[] = [];
  const includeMatcher = buildIncludePatternMatcher(opts.includePattern);

  const status = walkWorkspaceFiles(
    searchRoot,
    {
      deadlineAt: opts.deadlineAt,
      maxFilesScanned: opts.maxFilesScanned,
    },
    (filePath) => {
      if (opts.textOnly && !hasSearchableTextExtension(filePath)) return null;

      const workspaceRelative = stripWorkspaceRootPrefix(filePath);
      if (includeMatcher && !includeMatcher(workspaceRelative)) return null;

      const normalizedFilePath = filePath.replace(/\\/g, '/');
      if (opts.matcher && !opts.matcher(normalizedFilePath)) return null;

      files.push(filePath);
      if (opts.maxResults && files.length >= opts.maxResults) {
        return createTruncatedSearchStatus(`result limit (${opts.maxResults})`);
      }
      return null;
    },
  );

  files.sort((left, right) => left.localeCompare(right));
  return { files, status };
}

function errorResult(output: string): SearchToolRunResult {
  return { output, isError: true };
}

export function runGlobSearch(pattern: string): SearchToolRunResult {
  const normalizedWorkspacePattern = resolveWorkspaceGlobPattern(pattern);
  if (!normalizedWorkspacePattern) {
    return errorResult(
      'Error: glob only searches inside the workspace or configured external bind mounts. For other absolute paths, use bash.',
    );
  }

  const normalizedPattern = normalizedWorkspacePattern.replace(/\\/g, '/');
  const matcher = buildGlobMatcher(normalizedPattern);
  const searchRoot = resolveGlobSearchRoot(normalizedWorkspacePattern);
  if (!searchRoot) {
    return {
      output: `No files matched pattern: ${pattern}`,
      isError: false,
    };
  }
  const deadlineAt = computeSearchDeadline(GLOB_SEARCH_TIMEOUT_MS);
  const result = collectWorkspaceFiles(searchRoot, {
    deadlineAt,
    matcher,
    maxFilesScanned: GLOB_SEARCH_MAX_FILES_SCANNED,
    maxResults: GLOB_SEARCH_MAX_RESULTS,
    timeoutMs: GLOB_SEARCH_TIMEOUT_MS,
  });

  const note = buildSearchStatusNote(
    result.status,
    'glob',
    GLOB_SEARCH_TIMEOUT_MS,
  );
  return {
    output: formatSearchOutput(
      result.files.map(displaySearchPath),
      `No files matched pattern: ${pattern}`,
      note,
    ),
    isError: false,
  };
}

export function runGrepSearch(
  args: Record<string, unknown>,
): SearchToolRunResult {
  const pattern = readStringValue(args.pattern);
  if (!pattern) return errorResult('Error: pattern is required');
  const useRegex = readBooleanValue(args.regex) ?? false;

  const includePattern = readStringValue(args.include);
  const contextLines = Math.min(
    readNonNegativeIntegerValue(args.context) ?? 0,
    GREP_SEARCH_MAX_CONTEXT_LINES,
  );
  const searchPathArg = readStringValue(args.path);
  let searchPath = WORKSPACE_ROOT;
  if (searchPathArg) {
    try {
      searchPath = safeJoin(searchPathArg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(`Error: ${message}`);
    }
  }
  const deadlineAt = computeSearchDeadline(GREP_SEARCH_TIMEOUT_MS);

  const matcher = useRegex
    ? buildRegexSearchMatcher(pattern)
    : buildLiteralSubstringMatcher(pattern);
  if (typeof matcher === 'string') {
    return errorResult(`Error: ${matcher}`);
  }

  const fileCollection = collectWorkspaceFiles(searchPath, {
    deadlineAt,
    includePattern,
    maxFilesScanned: GREP_SEARCH_MAX_FILES_SCANNED,
    timeoutMs: GREP_SEARCH_TIMEOUT_MS,
    textOnly: true,
  });

  const matches: string[] = [];
  let status = fileCollection.status;
  let totalChars = 0;
  let matchCount = 0;

  for (const filePath of fileCollection.files) {
    if (Date.now() >= deadlineAt) {
      status = SEARCH_STATUS_TIMEOUT;
      break;
    }

    const content = readSearchableTextFile(filePath);
    if (content == null) continue;
    const lines = content.split('\n');

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (Date.now() >= deadlineAt) {
        status = SEARCH_STATUS_TIMEOUT;
        break;
      }

      if (!matcher(lines[lineIndex])) continue;

      matchCount += 1;
      if (matchCount > GREP_SEARCH_MAX_MATCHES) {
        status = createTruncatedSearchStatus(
          `match limit (${GREP_SEARCH_MAX_MATCHES})`,
        );
        break;
      }

      const start = Math.max(0, lineIndex - contextLines);
      const end = Math.min(lines.length, lineIndex + contextLines + 1);
      const displayPath = displaySearchPath(filePath);
      for (let ctx = start; ctx < end; ctx += 1) {
        const prefix = ctx === lineIndex ? '>' : ' ';
        const entry = `${displayPath}:${ctx + 1}:${prefix} ${lines[ctx]}`;
        const nextTotalChars = appendSearchOutputEntry(
          matches,
          entry,
          totalChars,
          GREP_SEARCH_MAX_OUTPUT_CHARS,
        );
        if (nextTotalChars == null) {
          status = createTruncatedSearchStatus(
            `output size limit (${formatBytes(GREP_SEARCH_MAX_OUTPUT_CHARS)})`,
          );
          break;
        }
        totalChars = nextTotalChars;
      }
      if (isSearchDone(status)) break;
      if (contextLines > 0) {
        const nextTotalChars = appendSearchOutputEntry(
          matches,
          '---',
          totalChars,
          GREP_SEARCH_MAX_OUTPUT_CHARS,
        );
        if (nextTotalChars == null) {
          status = createTruncatedSearchStatus(
            `output size limit (${formatBytes(GREP_SEARCH_MAX_OUTPUT_CHARS)})`,
          );
          break;
        }
        totalChars = nextTotalChars;
      }
    }

    if (isSearchDone(status)) break;
  }

  const note = buildSearchStatusNote(status, 'grep', GREP_SEARCH_TIMEOUT_MS);
  return {
    output: formatSearchOutput(matches, 'No matches found.', note),
    isError: false,
  };
}
