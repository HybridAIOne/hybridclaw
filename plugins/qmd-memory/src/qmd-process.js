import { runBoundedCli } from '@hybridaione/hybridclaw/plugin-sdk';

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

const MIN_PASSTHROUGH_TIMEOUT_MS = 15 * 60 * 1000;

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

function appendTruncationNotice(text, label) {
  const normalized = collapseTextWhitespace(text);
  const notice = `[QMD ${label} truncated]`;
  return normalized ? `${normalized}\n\n${notice}` : notice;
}

export async function runQmd(args, config, timeoutMs = config.timeoutMs) {
  return await runBoundedCli({
    command: config.command,
    args,
    cwd: config.workingDirectory,
    timeoutMs,
    maxChars: config.maxInjectedChars,
    label: 'QMD',
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
  // `qmd search|vsearch|query --json` prints a top-level array; only qmd's MCP
  // server wraps results in `{ results }`, and this plugin never calls it.
  if (!Array.isArray(parsed)) {
    throw new Error('QMD search results must be a JSON array.');
  }

  return parsed
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
  const result = await runQmd(
    args,
    config,
    Math.max(config.timeoutMs, MIN_PASSTHROUGH_TIMEOUT_MS),
  );
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
