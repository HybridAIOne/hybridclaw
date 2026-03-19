import { spawn } from 'node:child_process';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function truncate(value, maxChars) {
  const normalized = normalizeWhitespace(value);
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
  const nestedDocument = isRecord(source.document) ? source.document : {};
  const nestedDoc = isRecord(source.doc) ? source.doc : {};
  const nestedMetadata = isRecord(source.metadata) ? source.metadata : {};

  const title = firstNonEmptyString(
    source.title,
    nestedDocument.title,
    nestedDoc.title,
    source.displayPath,
    nestedDocument.displayPath,
    source.path,
    nestedDocument.path,
  );
  const path = firstNonEmptyString(
    source.displayPath,
    nestedDocument.displayPath,
    nestedDoc.displayPath,
    source.path,
    nestedDocument.path,
    nestedDoc.path,
    source.file,
    nestedMetadata.path,
  );
  const snippet = firstNonEmptyString(
    source.snippet,
    nestedDocument.snippet,
    source.preview,
    source.excerpt,
    nestedDocument.excerpt,
    source.content,
    nestedDocument.content,
    source.text,
  );
  const context = firstNonEmptyString(
    source.context,
    nestedDocument.context,
    nestedMetadata.context,
    source.collection,
    nestedMetadata.collection,
  );
  return {
    title: title || path || 'Untitled result',
    path,
    snippet,
    context,
    score: toFiniteNumber(source.score ?? nestedDocument.score ?? nestedDoc.score),
  };
}

function extractResultArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  const candidate =
    payload.results ??
    payload.matches ??
    payload.items ??
    payload.data ??
    payload.documents;
  return Array.isArray(candidate) ? candidate : [];
}

export async function runQmd(args, config) {
  return await new Promise((resolve) => {
    const child = spawn(config.command, args, {
      cwd: config.workingDirectory,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, config.timeoutMs);

    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      finish({ ok: false, stdout, stderr, error });
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        finish({
          ok: false,
          stdout,
          stderr,
          error: new Error(`QMD timed out after ${config.timeoutMs}ms.`),
        });
        return;
      }
      if (signal) {
        finish({
          ok: false,
          stdout,
          stderr,
          error: new Error(`QMD terminated with signal ${signal}.`),
        });
        return;
      }
      if (code !== 0) {
        finish({
          ok: false,
          stdout,
          stderr,
          error: new Error(
            normalizeWhitespace(stderr) || `QMD exited with code ${code}.`,
          ),
        });
        return;
      }
      finish({ ok: true, stdout, stderr });
    });
  });
}

function deriveQueryFromRecentMessages(recentMessages) {
  for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
    const message = recentMessages[index];
    if (!message || String(message.role || '').toLowerCase() !== 'user') {
      continue;
    }
    const content = truncate(message.content, 1000);
    if (content.length >= 3) return content;
  }
  return '';
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
    lines.push(`  Context: ${truncate(result.context, config.maxSnippetChars)}`);
  }
  if (result.snippet) {
    lines.push(`  Snippet: ${truncate(result.snippet, config.maxSnippetChars)}`);
  }
  return lines.join('\n');
}

function formatPromptContext(query, results, config) {
  if (results.length === 0) return null;

  const header = [
    'External QMD knowledge search results:',
    `Query: ${query}`,
  ].join('\n');

  let output = header;
  let appended = 0;

  for (const result of results) {
    const block = `\n\n${formatResultBlock(result, config)}`;
    if (output.length + block.length > config.maxInjectedChars) {
      const remaining = config.maxInjectedChars - output.length;
      if (remaining <= 3) break;
      if (appended === 0) {
        output += truncate(block.trim(), Math.max(remaining - 2, 0));
        appended += 1;
      }
      break;
    }
    output += block;
    appended += 1;
  }

  return appended > 0 ? output : null;
}

export async function buildQmdPromptContext(params) {
  const query = deriveQueryFromRecentMessages(params.recentMessages);
  if (!query) return null;

  const result = await runQmd(
    [
      params.config.searchMode,
      query,
      '--json',
      '-n',
      String(params.config.maxResults),
    ],
    params.config,
  );

  if (!result.ok) {
    throw result.error;
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('QMD returned invalid JSON for search results.');
  }

  const normalized = extractResultArray(parsed)
    .map((item) => normalizeResultItem(item))
    .filter((item) => item.snippet || item.context || item.path || item.title);

  return formatPromptContext(query, normalized, params.config);
}

export async function buildQmdStatusText(config) {
  const result = await runQmd(['status'], config);
  if (!result.ok) {
    throw result.error;
  }

  const statusText = normalizeWhitespace(result.stdout);
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
