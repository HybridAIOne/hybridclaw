import { spawn } from 'node:child_process';

// Strip generic question scaffolding and doc-reference noise from fallback queries.
const FALLBACK_QUERY_EXCLUDED_TERMS = new Set([
  'according',
  'are',
  'can',
  'did',
  'doc',
  'docs',
  'documentation',
  'does',
  'file',
  'files',
  'how',
  'page',
  'path',
  'say',
  'says',
  'show',
  'shows',
  'tell',
  'tells',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
]);

const MIN_CAPTURE_BYTES = 32_768;
const CAPTURE_BYTES_PER_INJECTED_CHAR = 2;
const MIN_PASSTHROUGH_TIMEOUT_MS = 15 * 60 * 1000;
const QMD_TIMEOUT_KILL_GRACE_MS = 250;
const QMD_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
];
const QMD_WINDOWS_ENV_ALLOWLIST = [
  'APPDATA',
  'ComSpec',
  'LOCALAPPDATA',
  'PATHEXT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERPROFILE',
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collapseTextWhitespace(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function truncate(value, maxChars) {
  const normalized = collapseTextWhitespace(value);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function toFiniteNumber(value) {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value)
        : Number.NaN;
  return Number.isFinite(numeric) ? numeric : undefined;
}

function normalizeResultItem(item) {
  const source = isRecord(item) ? item : {};
  const resultPath = firstNonEmptyString(
    source.displayPath,
    source.path,
    source.file,
  );
  return {
    title: firstNonEmptyString(source.title, resultPath) || 'Untitled result',
    path: resultPath,
    snippet: firstNonEmptyString(source.snippet),
    context: firstNonEmptyString(source.context, source.collection),
    score: toFiniteNumber(source.score),
  };
}

function extractResultArray(payload) {
  if (Array.isArray(payload)) return payload;
  // qmd search/vsearch/query --json currently returns a top-level array.
  // Keep a narrow compatibility path for wrapped payloads instead of probing
  // multiple speculative shapes.
  if (isRecord(payload) && Array.isArray(payload.results)) {
    return payload.results;
  }
  return [];
}

function resolveCaptureLimitBytes(config) {
  const configuredBudget =
    typeof config?.maxInjectedChars === 'number' &&
    Number.isFinite(config.maxInjectedChars)
      ? Math.max(0, Math.trunc(config.maxInjectedChars)) *
        CAPTURE_BYTES_PER_INJECTED_CHAR
      : 0;
  return Math.max(MIN_CAPTURE_BYTES, configuredBudget);
}

function createOutputCollector(maxBytes) {
  return {
    maxBytes,
    totalBytes: 0,
    truncated: false,
    chunks: [],
  };
}

function appendOutputChunk(collector, chunk) {
  const buffer = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk), 'utf-8');
  const remaining = collector.maxBytes - collector.totalBytes;
  if (remaining <= 0) {
    collector.truncated = true;
    return;
  }

  if (buffer.length <= remaining) {
    collector.totalBytes += buffer.length;
    collector.chunks.push(buffer);
    return;
  }

  collector.totalBytes += remaining;
  collector.chunks.push(buffer.subarray(0, remaining));
  collector.truncated = true;
}

function readCollectedOutput(collector) {
  if (collector.chunks.length === 0) return '';
  return Buffer.concat(collector.chunks).toString('utf-8');
}

function appendTruncationNotice(text, label) {
  const normalized = collapseTextWhitespace(text);
  const notice = `[QMD ${label} truncated]`;
  return normalized ? `${normalized}\n\n${notice}` : notice;
}

function buildQmdProcessEnv() {
  const env = {};
  const allowlist =
    process.platform === 'win32'
      ? [...QMD_ENV_ALLOWLIST, ...QMD_WINDOWS_ENV_ALLOWLIST]
      : QMD_ENV_ALLOWLIST;

  for (const key of allowlist) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) {
      env[key] = value;
    }
  }

  return env;
}

export async function runQmd(args, config) {
  const timeoutMs = config.timeoutMs;
  return await runQmdWithOptions(args, config, { timeoutMs });
}

async function runQmdWithOptions(args, config, options) {
  const timeoutMs =
    options && Object.hasOwn(options, 'timeoutMs')
      ? options.timeoutMs
      : config.timeoutMs;
  return await new Promise((resolve) => {
    const captureLimitBytes = resolveCaptureLimitBytes(config);
    const child = spawn(config.command, args, {
      cwd: config.workingDirectory,
      env: buildQmdProcessEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutCollector = createOutputCollector(captureLimitBytes);
    const stderrCollector = createOutputCollector(captureLimitBytes);
    let settled = false;
    let timedOut = false;
    let killTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({
        ...result,
        stdout: readCollectedOutput(stdoutCollector),
        stderr: readCollectedOutput(stderrCollector),
        stdoutTruncated: stdoutCollector.truncated,
        stderrTruncated: stderrCollector.truncated,
      });
    };

    const timer =
      typeof timeoutMs === 'number' &&
      Number.isFinite(timeoutMs) &&
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            killTimer = setTimeout(() => {
              if (!settled) {
                child.kill('SIGKILL');
              }
            }, QMD_TIMEOUT_KILL_GRACE_MS);
          }, timeoutMs)
        : null;

    child.stdout?.on('data', (chunk) => {
      appendOutputChunk(stdoutCollector, chunk);
    });

    child.stderr?.on('data', (chunk) => {
      appendOutputChunk(stderrCollector, chunk);
    });

    child.on('error', (error) => {
      finish({ ok: false, error });
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        finish({
          ok: false,
          error: new Error(`QMD timed out after ${timeoutMs}ms.`),
        });
        return;
      }
      if (signal) {
        finish({
          ok: false,
          error: new Error(`QMD terminated with signal ${signal}.`),
        });
        return;
      }
      if (code !== 0) {
        const stderrText = readCollectedOutput(stderrCollector);
        finish({
          ok: false,
          error: new Error(
            stderrCollector.truncated
              ? appendTruncationNotice(
                  stderrText || `QMD exited with code ${code}.`,
                  'stderr',
                )
              : collapseTextWhitespace(stderrText) ||
                  `QMD exited with code ${code}.`,
          ),
        });
        return;
      }
      finish({ ok: true });
    });
  });
}

function deriveQueryFromRecentMessages(recentMessages) {
  let latestContent = '';
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  let latestId = Number.NEGATIVE_INFINITY;
  let latestIndex = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < recentMessages.length; index += 1) {
    const message = recentMessages[index];
    if (!message || String(message.role || '').toLowerCase() !== 'user') {
      continue;
    }

    const content = truncate(message.content, 1000);
    if (content.length < 3) continue;

    const parsedTimestamp = Date.parse(String(message.created_at || ''));
    const timestamp = Number.isFinite(parsedTimestamp)
      ? parsedTimestamp
      : Number.NEGATIVE_INFINITY;
    const parsedId = Number(message.id);
    const numericId = Number.isFinite(parsedId)
      ? parsedId
      : Number.NEGATIVE_INFINITY;

    if (
      timestamp > latestTimestamp ||
      (timestamp === latestTimestamp && numericId > latestId) ||
      (timestamp === latestTimestamp &&
        numericId === latestId &&
        index > latestIndex)
    ) {
      latestContent = content;
      latestTimestamp = timestamp;
      latestId = numericId;
      latestIndex = index;
    }
  }

  return latestContent;
}

function deriveFallbackSearchQuery(query) {
  const seen = new Set();
  const terms = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter(
      (token) =>
        (token === 'qmd' || token.length >= 3) &&
        !FALLBACK_QUERY_EXCLUDED_TERMS.has(token),
    )
    .filter((token) => {
      if (seen.has(token)) return false;
      seen.add(token);
      return true;
    });

  return terms.length >= 2 ? terms.join(' ') : '';
}

async function searchQmd(query, config) {
  const result = await runQmd(
    [config.searchMode, '--json', '-n', String(config.maxResults), '--', query],
    config,
  );

  if (!result.ok) {
    throw result.error;
  }
  if (result.stdoutTruncated) {
    throw new Error('QMD search output exceeded the capture limit.');
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('QMD returned invalid JSON for search results.');
  }

  return extractResultArray(parsed)
    .map((item) => normalizeResultItem(item))
    .filter((item) => item.snippet || item.context || item.path || item.title);
}

function formatResultBlock(result, config) {
  const titleLine = [
    '-',
    result.title,
    result.path && result.path !== result.title ? `(${result.path})` : '',
    typeof result.score === 'number'
      ? `[score ${(result.score * 100).toFixed(0)}%]`
      : '',
  ]
    .filter(Boolean)
    .join(' ');

  const lines = [titleLine];
  if (result.context) {
    lines.push(
      `  Context: ${truncate(result.context, config.maxSnippetChars)}`,
    );
  }
  if (result.snippet) {
    lines.push(
      `  Snippet: ${truncate(result.snippet, config.maxSnippetChars)}`,
    );
  }
  return lines.join('\n');
}

function formatPromptContext(userQuery, searchQuery, results, config) {
  if (results.length === 0) return null;

  const header = [
    'External QMD knowledge search results:',
    'These results come from an external indexed knowledge base, not necessarily from files mounted in the current workspace.',
    'If the relevant answer is present below, answer from it directly and do not claim the source file is missing just because it is not available to workspace file tools.',
    `User question: ${userQuery}`,
    ...(searchQuery !== userQuery ? [`QMD search query: ${searchQuery}`] : []),
  ].join('\n');

  const firstBlockBudget = config.maxInjectedChars - header.length - 2;
  if (firstBlockBudget <= 0) return null;

  // Always include the top hit, truncating it if needed. Apply the budget check
  // only to additional results.
  let output = `${header}\n\n${truncate(
    formatResultBlock(results[0], config),
    firstBlockBudget,
  )}`;

  for (const result of results.slice(1)) {
    const block = `\n\n${formatResultBlock(result, config)}`;
    if (output.length + block.length > config.maxInjectedChars) {
      break;
    }
    output += block;
  }

  return output;
}

function summarizeTopResultPaths(results) {
  return results
    .slice(0, 3)
    .map((result) => firstNonEmptyString(result.path, result.title))
    .filter(Boolean);
}

export async function buildQmdPromptContextResult(params) {
  const userQuery = deriveQueryFromRecentMessages(params.recentMessages);
  if (!userQuery) {
    return {
      promptContext: null,
      userQuery: '',
      searchQuery: '',
      usedFallbackQuery: false,
      resultCount: 0,
      topResultPaths: [],
    };
  }

  const fallbackQuery = deriveFallbackSearchQuery(userQuery);
  const queries = [userQuery];
  if (fallbackQuery && fallbackQuery !== userQuery) {
    queries.push(fallbackQuery);
  }

  let searchQuery = userQuery;
  let normalized = [];
  for (const candidate of queries) {
    searchQuery = candidate;
    normalized = await searchQmd(candidate, params.config);
    if (normalized.length > 0) break;
  }

  return {
    promptContext: formatPromptContext(
      userQuery,
      searchQuery,
      normalized,
      params.config,
    ),
    userQuery,
    searchQuery,
    usedFallbackQuery: searchQuery !== userQuery,
    resultCount: normalized.length,
    topResultPaths: summarizeTopResultPaths(normalized),
  };
}

export async function buildQmdStatusText(config) {
  const result = await runQmd(['status'], config);
  if (!result.ok) {
    throw result.error;
  }

  const statusText =
    result.stdoutTruncated || result.stderrTruncated
      ? appendTruncationNotice(result.stdout, 'output')
      : collapseTextWhitespace(result.stdout);
  return [
    `Command: ${config.command}`,
    `Working directory: ${config.workingDirectory}`,
    `Search mode: ${config.searchMode}`,
    `Max results: ${config.maxResults}`,
    `Session export: ${config.sessionExport ? 'enabled' : 'disabled'}`,
    ...(config.sessionExport
      ? [`Session export directory: ${config.sessionExportDir}`]
      : []),
    '',
    statusText || 'QMD status returned no output.',
  ].join('\n');
}

export async function runQmdCommandText(args, config) {
  const result = await runQmdWithOptions(args, config, {
    timeoutMs: Math.max(config.timeoutMs, MIN_PASSTHROUGH_TIMEOUT_MS),
  });
  if (!result.ok) {
    throw result.error;
  }

  const output =
    result.stdoutTruncated || result.stderrTruncated
      ? appendTruncationNotice(result.stdout || result.stderr, 'output')
      : collapseTextWhitespace(result.stdout) ||
        collapseTextWhitespace(result.stderr);
  return output || 'QMD command completed with no output.';
}
