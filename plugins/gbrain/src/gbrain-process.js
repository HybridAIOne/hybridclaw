import { spawnSync } from 'node:child_process';
import {
  appendTruncationNotice,
  buildCliProcessEnv,
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
  'brain',
  'can',
  'did',
  'doc',
  'docs',
  'documentation',
  'does',
  'file',
  'files',
  'gbrain',
  'how',
  'page',
  'pages',
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

const MAX_DISCOVERY_CAPTURE_BYTES = 256 * 1024;
const MAX_PASSTHROUGH_CAPTURE_BYTES = 512 * 1024;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000;
const MIN_PASSTHROUGH_TIMEOUT_MS = 15 * 60 * 1000;
const COLLAPSE_SPACES = { collapseSpaces: true };
const GBRAIN_CREDENTIAL_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'DATABASE_URL',
  'GBRAIN_DATABASE_URL',
  'OPENAI_API_KEY',
];

function buildGbrainCredentialEnv(config) {
  const env = {};
  for (const key of GBRAIN_CREDENTIAL_ENV_KEYS) {
    const value =
      readString(config?.credentialEnv?.[key]) || readString(process.env[key]);
    if (value) env[key] = value;
  }
  return env;
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
        (token === 'ai' || token.length >= 3) &&
        !FALLBACK_QUERY_EXCLUDED_TERMS.has(token),
    )
    .filter((token) => {
      if (seen.has(token)) return false;
      seen.add(token);
      return true;
    });

  return terms.length >= 2 ? terms.join(' ') : '';
}

function normalizeSearchResultItem(item) {
  const source = isRecord(item) ? item : {};
  const slug = readString(source.slug);
  return {
    chunkSource: readString(source.chunk_source),
    score: readFiniteNumber(source.score),
    slug,
    snippet: readString(source.chunk_text) || readString(source.snippet),
    stale: source.stale === true,
    title: readString(source.title) || slug || 'Untitled page',
    type: readString(source.type) || 'page',
  };
}

function normalizeToolType(typeName) {
  const normalized = String(typeName || '')
    .trim()
    .replace(/\?$/, '')
    .toLowerCase();
  if (
    normalized === 'string' ||
    normalized === 'number' ||
    normalized === 'boolean' ||
    normalized === 'object' ||
    normalized === 'array'
  ) {
    return normalized;
  }
  return 'string';
}

function buildToolSchema(paramTypes) {
  const properties = {};
  const required = [];

  for (const [key, rawType] of Object.entries(paramTypes || {})) {
    if (typeof rawType !== 'string') continue;
    const optional = rawType.trim().endsWith('?');
    const type = normalizeToolType(rawType);
    properties[key] =
      type === 'array'
        ? {
            type,
            items: { type: 'string' },
          }
        : {
            type,
          };
    if (!optional) {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    required,
  };
}

function normalizeDiscoveredTool(item) {
  const source = isRecord(item) ? item : {};
  const operationName = readString(source.name);
  if (!operationName) return null;
  return {
    operationName,
    description:
      readString(source.description) || `Run gbrain ${operationName}.`,
    parameters: buildToolSchema(
      isRecord(source.parameters) ? source.parameters : {},
    ),
  };
}

export async function runGbrain(args, config, options) {
  return await runBoundedCli({
    command: config.command,
    args,
    cwd: config.workingDirectory,
    env: buildGbrainCredentialEnv(config),
    timeoutMs:
      options && Object.hasOwn(options, 'timeoutMs')
        ? options.timeoutMs
        : config.timeoutMs,
    maxBytes: options?.captureLimitBytes,
    maxChars: config.maxInjectedChars,
    label: 'GBrain',
  });
}

async function runGbrainJson(args, config, options) {
  const result = await runGbrain(args, config, options);
  if (!result.ok) {
    throw result.error;
  }
  if (result.stdoutTruncated) {
    throw new Error('GBrain JSON output exceeded the capture limit.');
  }

  const text = result.stdout.trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error || 'Unknown error');
    throw new Error(`GBrain returned invalid JSON: ${message}`);
  }
}

async function searchGbrain(query, operationName, config) {
  const payload = await runGbrainJson(
    [
      'call',
      operationName,
      JSON.stringify({
        limit: config.maxResults,
        query,
      }),
    ],
    config,
  );
  const items = Array.isArray(payload) ? payload : [];
  return items.map(normalizeSearchResultItem).filter((item) => item.slug);
}

function formatPromptContext(params) {
  const lines = [
    'External gbrain knowledge results:',
    'These results come from an external indexed knowledge brain and may reference pages that are not present in the current workspace.',
    'Answer from the retrieved snippets and slugs directly. Do not claim a page is missing solely because it is outside the workspace.',
    `User question: ${params.userQuestion}`,
    `GBrain retrieval mode: ${params.operationName}`,
    `GBrain search query: ${params.searchQuery}`,
    '',
  ];

  for (const [index, item] of params.results.entries()) {
    const scoreText =
      typeof item.score === 'number' ? `[${item.score.toFixed(4)}] ` : '';
    const header = [
      `${index + 1}. ${scoreText}${item.slug}`,
      `title: ${item.title}`,
      `type: ${item.type}`,
      item.chunkSource ? `source: ${item.chunkSource}` : '',
      item.stale ? 'stale: true' : '',
    ]
      .filter(Boolean)
      .join(' | ');
    lines.push(header);
    lines.push(
      truncateText(
        normalizeText(item.snippet, COLLAPSE_SPACES),
        params.maxSnippetChars,
      ),
    );
    lines.push('');
  }

  return truncateText(
    normalizeText(lines.join('\n').trim(), COLLAPSE_SPACES),
    params.maxInjectedChars,
  );
}

export async function buildGbrainPromptContextResult({
  config,
  recentMessages,
}) {
  const userQuestion = deriveQueryFromRecentMessages(recentMessages);
  if (!userQuestion) {
    return {
      promptContext: null,
      resultCount: 0,
      searchQuery: '',
      toolName: config.searchMode,
      topResultSlugs: [],
      usedFallbackQuery: false,
    };
  }

  const primaryOperation = config.searchMode;
  let searchQuery = userQuestion;
  let toolName = primaryOperation;
  let usedFallbackQuery = false;
  let results = await searchGbrain(searchQuery, primaryOperation, config);

  if (results.length === 0) {
    const fallbackQuery = deriveFallbackSearchQuery(userQuestion);
    if (fallbackQuery && fallbackQuery !== userQuestion) {
      searchQuery = fallbackQuery;
      toolName = 'search';
      usedFallbackQuery = true;
      results = await searchGbrain(searchQuery, 'search', config);
    }
  }

  return {
    promptContext:
      results.length > 0
        ? formatPromptContext({
            maxInjectedChars: config.maxInjectedChars,
            maxSnippetChars: config.maxSnippetChars,
            operationName: toolName,
            results,
            searchQuery,
            userQuestion,
          })
        : null,
    resultCount: results.length,
    searchQuery,
    toolName,
    topResultSlugs: results.map((item) => item.slug),
    usedFallbackQuery,
  };
}

export function discoverGbrainToolsSync(config) {
  const configuredTimeoutMs = Number(config.timeoutMs);
  const discoveryTimeoutMs =
    Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? configuredTimeoutMs
      : DEFAULT_DISCOVERY_TIMEOUT_MS;
  const result = spawnSync(config.command, ['--tools-json'], {
    cwd: config.workingDirectory,
    env: buildCliProcessEnv(buildGbrainCredentialEnv(config)),
    encoding: 'utf-8',
    maxBuffer: MAX_DISCOVERY_CAPTURE_BYTES,
    timeout: discoveryTimeoutMs,
  });

  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(
      `GBrain tool discovery timed out after ${discoveryTimeoutMs}ms.`,
    );
  }
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`GBrain tool discovery terminated with ${result.signal}.`);
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(
      normalizeText(result.stderr, COLLAPSE_SPACES) ||
        `GBrain tool discovery exited with code ${result.status}.`,
    );
  }

  const stdoutText = String(result.stdout || '[]');
  let parsed;
  try {
    parsed = JSON.parse(stdoutText);
  } catch (error) {
    const previewLimit = 200;
    const stdoutPreview = normalizeText(stdoutText, COLLAPSE_SPACES).slice(
      0,
      previewLimit,
    );
    const stderrPreview = normalizeText(
      String(result.stderr || ''),
      COLLAPSE_SPACES,
    ).slice(0, previewLimit);
    const parseMessage =
      error instanceof Error ? error.message : String(error || 'Unknown error');
    throw new Error(
      `Failed to parse GBrain tool discovery JSON: ${parseMessage}. stdout preview: ${stdoutPreview || '(empty)'}; stderr preview: ${stderrPreview || '(empty)'}.`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('GBrain tool discovery returned an unexpected payload.');
  }

  return parsed.map(normalizeDiscoveredTool).filter(Boolean);
}

export async function runGbrainTool(operationName, args, config) {
  return await runGbrainJson(
    ['call', operationName, JSON.stringify(isRecord(args) ? args : {})],
    config,
    {
      captureLimitBytes: MAX_PASSTHROUGH_CAPTURE_BYTES,
      timeoutMs: Math.max(config.timeoutMs, MIN_PASSTHROUGH_TIMEOUT_MS),
    },
  );
}

export async function buildGbrainStatusText(config, options) {
  const lines = [
    `Command: ${config.command}`,
    `Working directory: ${config.workingDirectory}`,
    `Search mode: ${config.searchMode}`,
    `Registered plugin tools: ${Number(options?.registeredToolCount || 0)}`,
  ];

  const [doctorResult, statsResult] = await Promise.allSettled([
    runGbrainJson(['doctor', '--json'], config, {
      timeoutMs: config.timeoutMs,
    }),
    runGbrainJson(['call', 'get_stats', '{}'], config, {
      timeoutMs: config.timeoutMs,
    }),
  ]);

  if (doctorResult.status === 'fulfilled' && isRecord(doctorResult.value)) {
    lines.push(`Doctor: ${readString(doctorResult.value.status) || 'ok'}`);
    const checks = Array.isArray(doctorResult.value.checks)
      ? doctorResult.value.checks
      : [];
    for (const check of checks) {
      if (!isRecord(check)) continue;
      const name = readString(check.name) || 'check';
      const status = readString(check.status) || 'unknown';
      const message = readString(check.message);
      lines.push(`- ${name}: ${status}${message ? ` (${message})` : ''}`);
    }
  } else if (doctorResult.status === 'rejected') {
    lines.push(
      `Doctor: unavailable (${doctorResult.reason instanceof Error ? doctorResult.reason.message : String(doctorResult.reason || 'unknown error')})`,
    );
  }

  if (statsResult.status === 'fulfilled' && isRecord(statsResult.value)) {
    const stats = statsResult.value;
    const pageCount = Number.isFinite(Number(stats.page_count))
      ? Number(stats.page_count)
      : null;
    const chunkCount = Number.isFinite(Number(stats.chunk_count))
      ? Number(stats.chunk_count)
      : null;
    const embeddedCount = Number.isFinite(Number(stats.embedded_count))
      ? Number(stats.embedded_count)
      : null;
    if (pageCount !== null || chunkCount !== null || embeddedCount !== null) {
      lines.push(
        [
          'Stats:',
          pageCount !== null ? `pages ${pageCount}` : '',
          chunkCount !== null ? `chunks ${chunkCount}` : '',
          embeddedCount !== null ? `embedded ${embeddedCount}` : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
    }
  }

  return lines.join('\n');
}

export async function runGbrainCommandText(args, config) {
  const result = await runGbrain(args, config, {
    captureLimitBytes: MAX_PASSTHROUGH_CAPTURE_BYTES,
    timeoutMs: Math.max(config.timeoutMs, MIN_PASSTHROUGH_TIMEOUT_MS),
  });

  if (!result.ok) {
    throw result.error;
  }

  const stdout = result.stdoutTruncated
    ? appendTruncationNotice(
        normalizeText(result.stdout, COLLAPSE_SPACES),
        'GBrain stdout',
      )
    : result.stdout.trim();
  const stderr = result.stderrTruncated
    ? appendTruncationNotice(
        normalizeText(result.stderr, COLLAPSE_SPACES),
        'GBrain stderr',
      )
    : result.stderr.trim();

  if (stdout && stderr) {
    return `${stdout}\n\n${stderr}`;
  }
  if (stdout) return stdout;
  if (stderr) return stderr;
  return 'GBrain command completed.';
}
