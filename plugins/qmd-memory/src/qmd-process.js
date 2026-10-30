import {
  appendTruncationNotice,
  isRecord,
  latestMessageByRole,
  normalizeText,
  readFiniteNumber,
  readString,
  runBoundedCli,
  truncateText,
} from '@hybridaione/hybridclaw/plugin-sdk';

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
const COLLAPSE_SPACES = { collapseSpaces: true };

function normalizeResultItem(item) {
  const source = isRecord(item) ? item : {};
  const resultPath =
    readString(source.displayPath) ||
    readString(source.path) ||
    readString(source.file);
  return {
    title: readString(source.title) || resultPath || 'Untitled result',
    path: resultPath,
    snippet: readString(source.snippet),
    context: readString(source.context) || readString(source.collection),
    score: readFiniteNumber(source.score),
  };
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
  const questions = recentMessages.filter(
    (message) => normalizeText(message?.content, COLLAPSE_SPACES).length >= 3,
  );
  return truncateText(
    normalizeText(
      latestMessageByRole(questions, 'user')?.content,
      COLLAPSE_SPACES,
    ),
    1000,
  );
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

  const fit = (text) =>
    truncateText(normalizeText(text, COLLAPSE_SPACES), config.maxSnippetChars);
  const lines = [titleLine];
  if (result.context) lines.push(`  Context: ${fit(result.context)}`);
  if (result.snippet) lines.push(`  Snippet: ${fit(result.snippet)}`);
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
  const topBlock = normalizeText(
    formatResultBlock(results[0], config),
    COLLAPSE_SPACES,
  );
  let output = `${header}\n\n${truncateText(topBlock, firstBlockBudget)}`;

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
    .map((result) => readString(result.path) || readString(result.title))
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
      ? appendTruncationNotice(
          normalizeText(result.stdout, COLLAPSE_SPACES),
          'QMD output',
        )
      : normalizeText(result.stdout, COLLAPSE_SPACES);
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
      ? appendTruncationNotice(
          normalizeText(result.stdout || result.stderr, COLLAPSE_SPACES),
          'QMD output',
        )
      : normalizeText(result.stdout, COLLAPSE_SPACES) ||
        normalizeText(result.stderr, COLLAPSE_SPACES);
  return output || 'QMD command completed with no output.';
}
