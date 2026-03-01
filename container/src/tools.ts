import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import type { ScheduleSideEffect, ToolDefinition } from './types.js';
import { webFetch } from './web-fetch.js';

// --- Exec safety deny-list (defense-in-depth, adapted from PicoClaw) ---

const DENY_PATTERNS: RegExp[] = [
  /\brm\s+-[rf]{1,2}\b/,           // rm -r, rm -f, rm -rf
  /(^|[;&|]\s*)mkfs(?:\.[a-z0-9_+-]+)?\b/, // mkfs command at segment start
  /(^|[;&|]\s*)format(?:\.com|\.exe)?\b/,  // format command at segment start (Windows)
  /\bdd\s+if=/,                      // raw disk I/O
  /:\(\)\s*\{.*\};\s*:/,            // fork bomb :(){ :|:& };:
  /\|\s*(sh|bash|zsh)\b/,           // pipe to shell
  /;\s*rm\s+-[rf]/,                  // chained rm after semicolon
  /&&\s*rm\s+-[rf]/,                 // chained rm after &&
  /\|\|\s*rm\s+-[rf]/,              // chained rm after ||
  /\bcurl\b.*\|\s*(sh|bash)/,       // curl | sh
  /\bwget\b.*\|\s*(sh|bash)/,       // wget | sh
  /\beval\b/,                        // eval execution
  /\bsource\s+.*\.sh\b/,            // source shell scripts
  /\bpkill\b/,                       // process killing
  /\bkillall\b/,                     // process killing
  /\bkill\s+-9\b/,                   // force kill
  /\b(shutdown|reboot|poweroff)\b/,  // system power control
  />\s*\/dev\/sd[a-z]\b/,           // write to block devices
];

function guardCommand(command: string): string | null {
  const lower = command.toLowerCase();
  for (const pattern of DENY_PATTERNS) {
    if (pattern.test(lower)) {
      return 'Command blocked by safety guard (dangerous pattern detected)';
    }
  }
  return null;
}

// --- Side-effect accumulator for host-processed actions ---

type ScheduledTaskInfo = { id: number; cronExpr: string; runAt: string | null; everyMs: number | null; prompt: string; enabled: number; lastRun: string | null; createdAt: string };

let pendingSchedules: ScheduleSideEffect[] = [];
let injectedTasks: ScheduledTaskInfo[] = [];
let currentSessionId = '';

export function resetSideEffects(): void {
  pendingSchedules = [];
}

export function getPendingSideEffects(): { schedules?: ScheduleSideEffect[] } | undefined {
  if (pendingSchedules.length === 0) return undefined;
  return { schedules: pendingSchedules };
}

export function setScheduledTasks(tasks: ScheduledTaskInfo[] | undefined): void {
  injectedTasks = tasks || [];
}

export function setSessionContext(sessionId: string): void {
  currentSessionId = String(sessionId || '');
}

const PREVIEW_MAX_OUTPUT_LINES = 6;
const PREVIEW_MAX_LINE_LENGTH = 200;
const BASH_MAX_OUTPUT_LINES = 400;
const BASH_MAX_OUTPUT_BYTES = 128 * 1024;
const BASH_EXEC_DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;
const BASH_EXEC_MIN_TIMEOUT_MS = 1_000;
const BASH_EXEC_MAX_TIMEOUT_MS = 15 * 60 * 1000;
const BASH_EXEC_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const READ_MAX_LINES = 2000;
const READ_MAX_BYTES = 50 * 1024;

function abbreviatePreview(text: string): string {
  const lines = text.split('\n');
  const truncated = lines.slice(0, PREVIEW_MAX_OUTPUT_LINES).map((line) =>
    line.length > PREVIEW_MAX_LINE_LENGTH ? line.slice(0, PREVIEW_MAX_LINE_LENGTH) + '...' : line
  );
  if (lines.length > PREVIEW_MAX_OUTPUT_LINES) {
    truncated.push(`... (${lines.length - PREVIEW_MAX_OUTPUT_LINES} more lines)`);
  }
  return truncated.join('\n');
}

type ReadTruncationResult = {
  content: string;
  truncated: boolean;
  truncatedBy: 'lines' | 'bytes' | null;
  outputLines: number;
  firstLineExceedsLimit: boolean;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function truncateReadContent(content: string, maxLines = READ_MAX_LINES, maxBytes = READ_MAX_BYTES): ReadTruncationResult {
  const lines = content.split('\n');
  const totalBytes = Buffer.byteLength(content, 'utf-8');
  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      outputLines: lines.length,
      firstLineExceedsLimit: false,
    };
  }

  const firstLine = lines[0] ?? '';
  if (Buffer.byteLength(firstLine, 'utf-8') > maxBytes) {
    return {
      content: '',
      truncated: true,
      truncatedBy: 'bytes',
      outputLines: 0,
      firstLineExceedsLimit: true,
    };
  }

  const out: string[] = [];
  let bytes = 0;
  let truncatedBy: 'lines' | 'bytes' = 'lines';
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, 'utf-8') + (i > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      break;
    }
    out.push(line);
    bytes += lineBytes;
  }

  if (out.length >= maxLines && bytes <= maxBytes) truncatedBy = 'lines';
  return {
    content: out.join('\n'),
    truncated: true,
    truncatedBy,
    outputLines: out.length,
    firstLineExceedsLimit: false,
  };
}

function formatBashOutput(content: string): string {
  const raw = content || '(no output)';
  const totalLines = raw.split('\n').length;
  const truncation = truncateReadContent(raw, BASH_MAX_OUTPUT_LINES, BASH_MAX_OUTPUT_BYTES);
  if (!truncation.truncated) return raw;

  if (truncation.firstLineExceedsLimit) {
    return `[Command output truncated: first line exceeds ${formatBytes(BASH_MAX_OUTPUT_BYTES)}. Consider narrowing command output.]`;
  }

  const shownLines = truncation.outputLines;
  if (truncation.truncatedBy === 'bytes') {
    return `${truncation.content}\n\n[Output truncated at ${formatBytes(BASH_MAX_OUTPUT_BYTES)} after ${shownLines}/${totalLines} lines]`;
  }
  return `${truncation.content}\n\n[Output truncated after ${shownLines}/${totalLines} lines]`;
}

function normalizeTimeoutNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clampTimeoutMs(rawMs: number): number {
  const rounded = Math.floor(rawMs);
  if (rounded < BASH_EXEC_MIN_TIMEOUT_MS) return BASH_EXEC_MIN_TIMEOUT_MS;
  if (rounded > BASH_EXEC_MAX_TIMEOUT_MS) return BASH_EXEC_MAX_TIMEOUT_MS;
  return rounded;
}

function resolveBashTimeoutMs(args: Record<string, unknown>): number {
  const timeoutMs = normalizeTimeoutNumber(args.timeoutMs);
  if (timeoutMs != null) return clampTimeoutMs(timeoutMs);

  const timeoutSeconds = normalizeTimeoutNumber(args.timeoutSeconds);
  if (timeoutSeconds != null) return clampTimeoutMs(timeoutSeconds * 1000);

  return BASH_EXEC_DEFAULT_TIMEOUT_MS;
}

const WORKSPACE_ROOT = '/workspace';

function safeJoin(userPath: string): string {
  const input = String(userPath || '').trim();
  const root = path.resolve(WORKSPACE_ROOT);
  const resolved = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(root, input);

  if (resolved === root || resolved.startsWith(root + path.sep)) {
    return resolved;
  }
  throw new Error(`Path escapes workspace: ${userPath}`);
}

const MEMORY_ROOT_FILES = new Set(['MEMORY.md', 'USER.md']);
const DAILY_MEMORY_FILE_RE = /^memory\/\d{4}-\d{2}-\d{2}\.md$/;
const ROOT_MEMORY_CHAR_LIMITS: Record<string, number> = {
  'MEMORY.md': 12_000,
  'USER.md': 8_000,
};
const DAILY_MEMORY_CHAR_LIMIT = 24_000;

function normalizeDateStamp(input: string): string | null {
  const trimmed = input.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function currentDateStamp(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  if (year && month && day) return `${year}-${month}-${day}`;
  return new Date().toISOString().slice(0, 10);
}

function normalizeMemoryFilePath(rawPath: unknown): string | null {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') return null;
  const normalized = rawPath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/workspace\//, '')
    .replace(/^\.?\//, '');
  if (MEMORY_ROOT_FILES.has(normalized)) return normalized;
  if (DAILY_MEMORY_FILE_RE.test(normalized)) return normalized;
  return null;
}

function resolveMemoryFilePath(args: Record<string, unknown>): string | null {
  const direct =
    normalizeMemoryFilePath(args.file_path) ||
    normalizeMemoryFilePath(args.path);
  if (direct) return direct;

  const target = typeof args.target === 'string' ? args.target.trim().toLowerCase() : '';
  if (target === 'memory') return 'MEMORY.md';
  if (target === 'user') return 'USER.md';
  if (target === 'daily') {
    const date = typeof args.date === 'string' ? normalizeDateStamp(args.date) : null;
    return `memory/${date || currentDateStamp()}.md`;
  }

  return 'MEMORY.md';
}

function listMemoryFiles(): string[] {
  const files: string[] = [];
  for (const rootFile of MEMORY_ROOT_FILES) {
    const abs = safeJoin(rootFile);
    if (fs.existsSync(abs)) files.push(rootFile);
  }

  const dailyDir = safeJoin('memory');
  if (fs.existsSync(dailyDir)) {
    for (const entry of fs.readdirSync(dailyDir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(entry)) continue;
      files.push(`memory/${entry}`);
    }
  }

  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function memoryCharLimit(relativePath: string): number {
  return ROOT_MEMORY_CHAR_LIMITS[relativePath] || DAILY_MEMORY_CHAR_LIMIT;
}

interface TranscriptRow {
  sessionId: string;
  channelId?: string;
  role: string;
  userId?: string;
  username?: string | null;
  content: string;
  createdAt?: string;
}

type SessionSearchCandidate = {
  sessionId: string;
  filePath: string;
  rows: TranscriptRow[];
  matchIndexes: number[];
  score: number;
  mtimeMs: number;
};

const SESSION_TRANSCRIPTS_DIR = '.session-transcripts';
const SESSION_SEARCH_MAX_FILES = 300;
const SESSION_SEARCH_MAX_RESULTS = 5;
const SESSION_SEARCH_MAX_ROWS_PER_SESSION = 2_000;
const SESSION_SEARCH_SNIPPET_CONTEXT = 1;
const SESSION_SEARCH_MAX_SNIPPETS = 8;

function parseRoleFilter(value: unknown): Set<string> | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const roles = value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return roles.length > 0 ? new Set(roles) : null;
}

function truncateInline(text: string, max = 240): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}...`;
}

function collectTranscriptRows(filePath: string): TranscriptRow[] {
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const parsed: TranscriptRow[] = [];
  const lines = raw.split('\n').filter(Boolean);
  const start = Math.max(0, lines.length - SESSION_SEARCH_MAX_ROWS_PER_SESSION);
  for (let i = start; i < lines.length; i++) {
    try {
      const row = JSON.parse(lines[i]) as Partial<TranscriptRow>;
      if (
        typeof row.sessionId !== 'string' ||
        typeof row.role !== 'string' ||
        typeof row.content !== 'string'
      ) {
        continue;
      }
      parsed.push({
        sessionId: row.sessionId,
        channelId: typeof row.channelId === 'string' ? row.channelId : undefined,
        role: row.role,
        userId: typeof row.userId === 'string' ? row.userId : undefined,
        username: row.username == null ? null : String(row.username),
        content: row.content,
        createdAt: typeof row.createdAt === 'string' ? row.createdAt : undefined,
      });
    } catch {
      // Skip malformed row
    }
  }
  return parsed;
}

function scoreTranscript(rows: TranscriptRow[], query: string, roleFilter: Set<string> | null): number {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);
  if (terms.length === 0) terms.push(query.toLowerCase());

  let score = 0;
  for (const row of rows) {
    const role = row.role.toLowerCase();
    if (roleFilter && !roleFilter.has(role)) continue;
    const haystack = row.content.toLowerCase();
    if (haystack.includes(query.toLowerCase())) score += 6;
    for (const term of terms) {
      if (haystack.includes(term)) score += 2;
    }
  }
  return score;
}

function findMatchIndexes(rows: TranscriptRow[], query: string, roleFilter: Set<string> | null): number[] {
  const lower = query.toLowerCase();
  const terms = lower
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);
  if (terms.length === 0) terms.push(lower);

  const indexes: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const role = rows[i].role.toLowerCase();
    if (roleFilter && !roleFilter.has(role)) continue;
    const content = rows[i].content.toLowerCase();
    if (content.includes(lower) || terms.some((term) => content.includes(term))) {
      indexes.push(i);
    }
  }
  return indexes;
}

function summarizeSessionCandidate(candidate: SessionSearchCandidate, query: string): Record<string, unknown> {
  const rows = candidate.rows;
  const snippets: string[] = [];
  const seenIndexes = new Set<number>();

  for (const idx of candidate.matchIndexes) {
    const from = Math.max(0, idx - SESSION_SEARCH_SNIPPET_CONTEXT);
    const to = Math.min(rows.length - 1, idx + SESSION_SEARCH_SNIPPET_CONTEXT);
    for (let i = from; i <= to; i++) {
      if (seenIndexes.has(i)) continue;
      seenIndexes.add(i);
      const line = `[${rows[i].role.toUpperCase()}] ${truncateInline(rows[i].content)}`;
      snippets.push(line);
      if (snippets.length >= SESSION_SEARCH_MAX_SNIPPETS) break;
    }
    if (snippets.length >= SESSION_SEARCH_MAX_SNIPPETS) break;
  }

  const userMatches: string[] = [];
  const assistantMatches: string[] = [];
  for (const idx of candidate.matchIndexes) {
    const row = rows[idx];
    const role = row.role.toLowerCase();
    if (role === 'user' && userMatches.length < 2) {
      userMatches.push(truncateInline(row.content));
    } else if (role === 'assistant' && assistantMatches.length < 2) {
      assistantMatches.push(truncateInline(row.content));
    }
  }

  const firstTs = rows.find((row) => typeof row.createdAt === 'string')?.createdAt || null;
  const lastTs = [...rows].reverse().find((row) => typeof row.createdAt === 'string')?.createdAt || null;
  const summaryParts = [
    `Matched ${candidate.matchIndexes.length} turn(s) for "${query}".`,
    userMatches.length > 0 ? `User focus: ${userMatches.join(' | ')}` : '',
    assistantMatches.length > 0 ? `Assistant outcomes: ${assistantMatches.join(' | ')}` : '',
  ].filter(Boolean);

  return {
    session_id: candidate.sessionId,
    match_count: candidate.matchIndexes.length,
    first_message_at: firstTs,
    last_message_at: lastTs,
    summary: summaryParts.join(' '),
    snippets,
  };
}

export async function executeTool(name: string, argsJson: string): Promise<string> {
  try {
    const args = JSON.parse(argsJson);

    switch (name) {
      case 'read': {
        if (typeof args.path !== 'string' || args.path.trim() === '') {
          return 'Error: path is required';
        }
        const filePath = safeJoin(args.path);
        if (!fs.existsSync(filePath)) return `Error: File not found: ${args.path}`;
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const totalFileLines = lines.length;

        const rawOffset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? args.offset : 1;
        const startLine = Math.max(1, Math.floor(rawOffset));
        if (startLine > totalFileLines) {
          return `Error: Offset ${startLine} is beyond end of file (${totalFileLines} lines total)`;
        }

        const rawLimit =
          typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
            ? Math.floor(args.limit)
            : undefined;

        let selected = lines.slice(startLine - 1);
        let userLimitedLines: number | undefined;
        if (rawLimit !== undefined) {
          selected = selected.slice(0, rawLimit);
          userLimitedLines = selected.length;
        }

        const selectedContent = selected.join('\n');
        const truncation = truncateReadContent(selectedContent);
        if (truncation.firstLineExceedsLimit) {
          const firstSelectedLine = selected[0] ?? '';
          const firstLineSize = formatBytes(Buffer.byteLength(firstSelectedLine, 'utf-8'));
          return `[Line ${startLine} is ${firstLineSize}, exceeds ${formatBytes(READ_MAX_BYTES)} limit. Use bash: sed -n '${startLine}p' ${args.path} | head -c ${READ_MAX_BYTES}]`;
        }

        if (truncation.truncated) {
          const endLine = startLine + truncation.outputLines - 1;
          const nextOffset = endLine + 1;
          if (truncation.truncatedBy === 'lines') {
            return `${truncation.content}\n\n[Showing lines ${startLine}-${endLine} of ${totalFileLines}. Use offset=${nextOffset} to continue]`;
          }
          return `${truncation.content}\n\n[Showing lines ${startLine}-${endLine} of ${totalFileLines} (${formatBytes(READ_MAX_BYTES)} limit). Use offset=${nextOffset} to continue]`;
        }

        if (userLimitedLines !== undefined) {
          const linesFromStart = startLine - 1 + userLimitedLines;
          if (linesFromStart < totalFileLines) {
            const remaining = totalFileLines - linesFromStart;
            const nextOffset = startLine + userLimitedLines;
            return `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue]`;
          }
        }

        return truncation.content;
      }

      case 'write': {
        const filePath = safeJoin(args.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, args.contents);
        return `Wrote ${args.contents.length} bytes to ${args.path}`;
      }

      case 'edit': {
        const filePath = safeJoin(args.path);
        if (!fs.existsSync(filePath)) return `Error: File not found: ${args.path}`;
        let content = fs.readFileSync(filePath, 'utf-8');
        const count = args.count || 1;
        for (let i = 0; i < count; i++) {
          const idx = content.indexOf(args.old);
          if (idx === -1) {
            if (i === 0) return `Error: Text not found in ${args.path}`;
            break;
          }
          content = content.slice(0, idx) + args.new + content.slice(idx + args.old.length);
        }
        fs.writeFileSync(filePath, content);
        return `Edited ${args.path} (${count} replacement${count > 1 ? 's' : ''})`;
      }

      case 'delete': {
        const filePath = safeJoin(args.path);
        if (!fs.existsSync(filePath)) return `Error: File not found: ${args.path}`;
        fs.unlinkSync(filePath);
        return `Deleted ${args.path}`;
      }

      case 'glob': {
        const pattern = args.pattern;
        try {
          // Use find as a simple glob implementation
          const cmd = `find /workspace -path "${pattern.replace(/\*/g, '*')}" -type f 2>/dev/null | head -50`;
          const result = execSync(cmd, { timeout: 10000, encoding: 'utf-8' });
          if (!result.trim()) return 'No files found.';
          // Convert absolute paths to relative
          const files = result.trim().split('\n').map((f) => f.replace('/workspace/', ''));
          return abbreviatePreview(files.join('\n'));
        } catch {
          return 'No files found.';
        }
      }

      case 'grep': {
        const searchPath = args.path ? safeJoin(args.path) : '/workspace';
        try {
          const cmd = `rg --no-heading --line-number "${args.pattern.replace(/"/g, '\\"')}" "${searchPath}" 2>/dev/null | head -30`;
          const result = execSync(cmd, { timeout: 10000, encoding: 'utf-8' });
          if (!result.trim()) return 'No matches found.';
          // Convert absolute paths to relative
          return abbreviatePreview(result.replace(/\/workspace\//g, ''));
        } catch {
          return 'No matches found.';
        }
      }

      case 'bash': {
        const blocked = guardCommand(args.command);
        if (blocked) return blocked;
        const timeoutMs = resolveBashTimeoutMs(args);
        try {
          // Strip secrets from subprocess environment (belt-and-suspenders)
          const cleanEnv = { ...process.env };
          delete cleanEnv.HYBRIDAI_API_KEY;
          const result = execSync(args.command, {
            timeout: timeoutMs,
            encoding: 'utf-8',
            cwd: '/workspace',
            maxBuffer: BASH_EXEC_MAX_BUFFER_BYTES,
            env: cleanEnv,
          });
          return formatBashOutput(result || '(no output)');
        } catch (err: unknown) {
          const execErr = err as {
            code?: string | number;
            signal?: string;
            stdout?: string | Buffer;
            stderr?: string | Buffer;
            message?: string;
          };

          const stdout = typeof execErr.stdout === 'string'
            ? execErr.stdout
            : Buffer.isBuffer(execErr.stdout)
              ? execErr.stdout.toString('utf-8')
              : '';
          const stderr = typeof execErr.stderr === 'string'
            ? execErr.stderr
            : Buffer.isBuffer(execErr.stderr)
              ? execErr.stderr.toString('utf-8')
              : '';
          const combinedOutput = [stdout, stderr].filter(Boolean).join('\n').trim();

          const errorMessage = execErr.message || 'Command failed';
          const timeoutLikely =
            execErr.code === 'ETIMEDOUT'
            || /ETIMEDOUT|timed out/i.test(errorMessage)
            || (execErr.signal === 'SIGTERM' && /spawnSync/i.test(errorMessage));
          const summary = timeoutLikely
            ? `Command timed out after ${timeoutMs}ms`
            : errorMessage;

          if (!combinedOutput) return `Error: ${summary}`;
          return `Error: ${summary}\n\n${formatBashOutput(combinedOutput)}`;
        }
      }

      case 'memory': {
        const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : 'read';
        const relativePath = resolveMemoryFilePath(args);
        if (!relativePath) {
          return 'Error: memory file_path must be MEMORY.md, USER.md, or memory/YYYY-MM-DD.md';
        }

        const filePath = safeJoin(relativePath);
        if (action === 'list') {
          const files = listMemoryFiles();
          if (files.length === 0) {
            return 'No memory files found yet. Use action="append" with MEMORY.md or memory/YYYY-MM-DD.md.';
          }
          return files.join('\n');
        }

        if (action === 'search') {
          const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
          if (!query) return 'Error: query is required for memory search';
          const files = listMemoryFiles();
          const matches: string[] = [];
          for (const rel of files) {
            const abs = safeJoin(rel);
            let lines: string[] = [];
            try {
              lines = fs.readFileSync(abs, 'utf-8').split('\n');
            } catch {
              continue;
            }
            for (let i = 0; i < lines.length; i++) {
              if (!lines[i].toLowerCase().includes(query)) continue;
              const trimmed = lines[i].trim();
              matches.push(`${rel}:${i + 1}: ${trimmed}`);
              if (matches.length >= 40) break;
            }
            if (matches.length >= 40) break;
          }
          return matches.length > 0 ? matches.join('\n') : `No memory matches for "${query}".`;
        }

        if (action === 'read') {
          if (!fs.existsSync(filePath)) {
            return `${relativePath}\n\n(empty)`;
          }
          const content = fs.readFileSync(filePath, 'utf-8');
          return `${relativePath}\n\n${content || '(empty)'}`;
        }

        if (action === 'append') {
          const content = typeof args.content === 'string' ? args.content.trim() : '';
          if (!content) return 'Error: content is required for memory append';

          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
          let next = existing.replace(/\s+$/, '');
          if (next.length > 0) next += '\n\n';
          next += `${content}\n`;
          const limit = memoryCharLimit(relativePath);
          if (next.length > limit) {
            return `Error: ${relativePath} would exceed ${limit} chars. Shorten content or remove older entries first.`;
          }
          fs.writeFileSync(filePath, next, 'utf-8');
          return `Appended ${content.length} chars to ${relativePath}`;
        }

        if (action === 'write') {
          const content = typeof args.content === 'string' ? args.content : '';
          const limit = memoryCharLimit(relativePath);
          if (content.length > limit) {
            return `Error: ${relativePath} exceeds ${limit} char limit.`;
          }
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, content, 'utf-8');
          return `Wrote ${content.length} chars to ${relativePath}`;
        }

        if (action === 'replace') {
          const oldText = typeof args.old_text === 'string' ? args.old_text : '';
          const newText = typeof args.new_text === 'string' ? args.new_text : '';
          if (!oldText) return 'Error: old_text is required for memory replace';
          if (!fs.existsSync(filePath)) return `Error: File not found: ${relativePath}`;
          const content = fs.readFileSync(filePath, 'utf-8');
          if (!content.includes(oldText)) return `Error: old_text not found in ${relativePath}`;
          const next = content.replace(oldText, newText);
          const limit = memoryCharLimit(relativePath);
          if (next.length > limit) {
            return `Error: replacement would exceed ${limit} chars for ${relativePath}.`;
          }
          fs.writeFileSync(filePath, next, 'utf-8');
          return `Updated ${relativePath}`;
        }

        if (action === 'remove') {
          const oldText = typeof args.old_text === 'string' ? args.old_text : '';
          if (!oldText) return 'Error: old_text is required for memory remove';
          if (!fs.existsSync(filePath)) return `Error: File not found: ${relativePath}`;
          const content = fs.readFileSync(filePath, 'utf-8');
          if (!content.includes(oldText)) return `Error: old_text not found in ${relativePath}`;
          fs.writeFileSync(filePath, content.replace(oldText, ''), 'utf-8');
          return `Removed matching text from ${relativePath}`;
        }

        return `Error: unknown memory action "${action}". Use read, append, write, replace, remove, list, or search.`;
      }

      case 'session_search': {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) return 'Error: query is required for session_search';

        const requestedLimit =
          typeof args.limit === 'number' && Number.isFinite(args.limit)
            ? Math.floor(args.limit)
            : 3;
        const limit = Math.max(1, Math.min(requestedLimit, SESSION_SEARCH_MAX_RESULTS));
        const includeCurrent = args.include_current === true;
        const roleFilter = parseRoleFilter(args.role_filter);

        const transcriptDir = safeJoin(SESSION_TRANSCRIPTS_DIR);
        if (!fs.existsSync(transcriptDir)) {
          return JSON.stringify({
            success: true,
            query,
            count: 0,
            results: [],
            message: 'No historical transcripts found yet.',
          }, null, 2);
        }

        const files = fs
          .readdirSync(transcriptDir)
          .filter((name) => name.endsWith('.jsonl'))
          .slice(0, SESSION_SEARCH_MAX_FILES);

        const candidates: SessionSearchCandidate[] = [];
        for (const filename of files) {
          const filePath = path.join(transcriptDir, filename);
          const rows = collectTranscriptRows(filePath);
          if (rows.length === 0) continue;

          const sessionId = rows[0].sessionId || filename.replace(/\.jsonl$/, '');
          if (!includeCurrent && currentSessionId && sessionId === currentSessionId) continue;

          const matchIndexes = findMatchIndexes(rows, query, roleFilter);
          if (matchIndexes.length === 0) continue;

          const stat = fs.statSync(filePath);
          const score = scoreTranscript(rows, query, roleFilter);
          candidates.push({
            sessionId,
            filePath,
            rows,
            matchIndexes,
            score,
            mtimeMs: stat.mtimeMs,
          });
        }

        candidates.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return b.mtimeMs - a.mtimeMs;
        });

        const top = candidates.slice(0, limit);
        const results = top.map((candidate) => summarizeSessionCandidate(candidate, query));

        return JSON.stringify({
          success: true,
          query,
          count: results.length,
          sessions_searched: candidates.length,
          results,
        }, null, 2);
      }

      case 'web_fetch': {
        const result = await webFetch({
          url: args.url,
          extractMode: args.extractMode,
          maxChars: args.maxChars,
        });
        const header = result.title ? `# ${result.title}\n\n` : '';
        const meta = `[${result.extractor}] ${result.finalUrl} (${result.status}, ${result.tookMs}ms)`;
        return `${meta}\n\n${header}${result.text}`;
      }

      case 'cron': {
        const action = args.action;

        if (action === 'list') {
          if (injectedTasks.length === 0) return 'No scheduled tasks.';
          const lines = injectedTasks.map((t) => {
            let schedule: string;
            if (t.runAt) schedule = `at ${t.runAt}`;
            else if (t.everyMs) {
              const secs = t.everyMs / 1000;
              if (secs < 120) schedule = `every ${secs}s`;
              else if (secs < 7200) schedule = `every ${Math.round(secs / 60)}m`;
              else schedule = `every ${Math.round(secs / 3600)}h`;
            } else schedule = t.cronExpr;
            const status = t.enabled ? 'enabled' : 'disabled';
            return `#${t.id} [${status}] ${schedule} — ${t.prompt}`;
          });
          return lines.join('\n');
        }

        if (action === 'add') {
          if (!args.prompt) return 'Error: prompt is required';

          if (args.at) {
            const runAt = new Date(args.at);
            if (isNaN(runAt.getTime())) return `Error: invalid ISO-8601 timestamp: ${args.at}`;
            if (runAt.getTime() <= Date.now()) return `Error: timestamp must be in the future: ${args.at}`;
            pendingSchedules.push({ action: 'add', runAt: runAt.toISOString(), prompt: args.prompt });
            return `Scheduled one-shot task at ${runAt.toISOString()}: ${args.prompt}`;
          }

          if (args.cron) {
            pendingSchedules.push({ action: 'add', cronExpr: args.cron, prompt: args.prompt });
            return `Scheduled recurring task with cron "${args.cron}": ${args.prompt}`;
          }

          if (args.every) {
            const secs = Number(args.every);
            if (isNaN(secs) || secs < 10) return 'Error: "every" must be a number of seconds >= 10';
            const everyMs = Math.round(secs * 1000);
            pendingSchedules.push({ action: 'add', everyMs, prompt: args.prompt });
            return `Scheduled interval task every ${secs}s: ${args.prompt}`;
          }

          return 'Error: provide "at" (ISO-8601 timestamp), "cron" (cron expression), or "every" (seconds)';
        }

        if (action === 'remove') {
          if (!args.taskId) return 'Error: taskId is required';
          pendingSchedules.push({ action: 'remove', taskId: args.taskId });
          return `Scheduled removal of task #${args.taskId}`;
        }

        return `Error: unknown cron action "${action}". Use "list", "add", or "remove".`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read',
      description:
        'Read a file and return its contents. Output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to read' },
          offset: { type: 'number', description: 'Line number to start reading from (1-indexed, default: 1)' },
          limit: { type: 'number', description: 'Maximum number of lines to read before truncation logic (optional)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description:
        'Write contents to a file on disk, overwriting if it exists. Use this for creating new code/program files instead of shell heredocs or code-only replies.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to write' },
          contents: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'contents'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit',
      description:
        'Replace text in a file using old/new strings. Use this for file edits instead of shell-based editing (sed/awk/perl in bash).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to edit' },
          old: { type: 'string', description: 'Text to find and replace' },
          new: { type: 'string', description: 'Replacement text' },
          count: { type: 'number', description: 'Number of replacements (default: 1)' },
        },
        required: ['path', 'old', 'new'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete',
      description: 'Delete a file from the workspace',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to delete' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'List files matching a glob pattern',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match files' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search for a regex pattern in files',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'Directory or file to search in (default: workspace root)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a shell command and return stdout/stderr. Do not use for file creation or file editing; use write/edit tools for file authoring.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          timeoutMs: { type: 'number', description: 'Optional command timeout in milliseconds (default 240000, max 900000)' },
          timeoutSeconds: { type: 'number', description: 'Optional command timeout in seconds (used when timeoutMs is omitted)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory',
      description:
        'Manage durable agent memory files. Supports MEMORY.md, USER.md, and daily files at memory/YYYY-MM-DD.md. Actions: read, append, write, replace, remove, list, search. Memory files are char-bounded to prevent unbounded growth.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Action: "read", "append", "write", "replace", "remove", "list", or "search"' },
          file_path: { type: 'string', description: 'Target file path. Allowed: MEMORY.md, USER.md, memory/YYYY-MM-DD.md' },
          target: { type: 'string', description: 'Optional shorthand target: "memory", "user", or "daily"' },
          date: { type: 'string', description: 'Date for target="daily" in YYYY-MM-DD format (defaults to today)' },
          content: { type: 'string', description: 'Text payload for append/write' },
          old_text: { type: 'string', description: 'Existing substring for replace/remove' },
          new_text: { type: 'string', description: 'Replacement text for replace' },
          query: { type: 'string', description: 'Case-insensitive query string for search' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'session_search',
      description:
        'Search and summarize historical session transcripts. Returns top matching sessions with concise summaries and key snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query over prior session transcripts' },
          limit: { type: 'number', description: 'Maximum number of sessions to summarize (default 3, max 5)' },
          role_filter: { type: 'string', description: 'Optional comma-separated roles to match (e.g. "user,assistant")' },
          include_current: { type: 'boolean', description: 'Include the current session in results (default false)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Fetch a URL and extract its readable content as markdown or plain text. Works with HTML pages, JSON APIs, and markdown URLs. Use for reading web pages, documentation, API responses, etc.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'HTTP or HTTPS URL to fetch' },
          extractMode: {
            type: 'string',
            description: 'Extraction mode: "markdown" (default) or "text"',
          },
          maxChars: {
            type: 'number',
            description: 'Maximum characters to return (default 50000, max 50000)',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cron',
      description:
        'Manage scheduled tasks and reminders. Actions:\n' +
        '- "list": show all scheduled tasks\n' +
        '- "add": create a task. Provide "prompt" plus one of: "at" (ISO-8601 timestamp for one-shot), "cron" (cron expression for cron-based recurring), or "every" (interval in seconds for simple recurring)\n' +
        '- "remove": delete a task by taskId\n' +
        'For relative times like "in 5 minutes", compute the ISO-8601 timestamp and use "at".',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Action to perform: "list", "add", or "remove"' },
          prompt: { type: 'string', description: 'Task prompt / reminder text (required for "add")' },
          at: { type: 'string', description: 'ISO-8601 timestamp for one-shot schedule (e.g. "2025-01-15T14:30:00Z")' },
          cron: { type: 'string', description: 'Cron expression for recurring schedule (e.g. "0 9 * * *")' },
          every: { type: 'number', description: 'Interval in seconds for simple recurring schedule (minimum 10)' },
          taskId: { type: 'number', description: 'Task ID to remove (required for "remove")' },
        },
        required: ['action'],
      },
    },
  },
];
