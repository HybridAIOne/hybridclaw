#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const DEFAULT_BASE_URL = 'https://api.firecrawl.dev/v2';
const SECRET_NAME = 'FIRECRAWL_API_KEY';
const SKILL_NAME = 'firecrawl';
const DEFAULT_CRAWL_LIMIT = 25;
const DEFAULT_MAP_LIMIT = 500;
const MAX_CRAWL_LIMIT = 10_000;
const MAX_MAP_LIMIT = 100_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4_000_000;

const COMMAND_ALIASES = new Map([
  ['scrape', 'scrape.url'],
  ['crawl', 'crawl.site'],
  ['map', 'map.site'],
  ['extract', 'extract.structured'],
]);

const COMMANDS = new Set([
  'scrape.url',
  'crawl.site',
  'crawl.status',
  'crawl.cancel',
  'crawl.active',
  'map.site',
  'extract.structured',
  'extract.status',
]);

function usage() {
  return `
Firecrawl skill helper

Build gateway-proxied http_request payloads for the managed Firecrawl API.

Usage:
  node skills/firecrawl/firecrawl.cjs [--format json] http-request scrape.url --url https://example.com [--format-name markdown]
  node skills/firecrawl/firecrawl.cjs [--format json] http-request crawl.site --url https://example.com/docs [--limit 25]
  node skills/firecrawl/firecrawl.cjs [--format json] http-request crawl.status --id <crawl-id>
  node skills/firecrawl/firecrawl.cjs [--format json] http-request crawl.cancel --id <crawl-id>
  node skills/firecrawl/firecrawl.cjs [--format json] http-request map.site --url https://example.com [--limit 500]
  node skills/firecrawl/firecrawl.cjs [--format json] http-request extract.structured --url https://example.com/* --schema-json '{"type":"object"}' --prompt "Extract product facts"
  node skills/firecrawl/firecrawl.cjs [--format json] http-request extract.status --id <extract-id>

Global options:
  --format json|pretty       Output JSON or pretty-printed JSON. Default: pretty.
  --timeout-ms <ms>          Gateway request timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --max-response-bytes <n>   Gateway response cap. Default: ${DEFAULT_MAX_RESPONSE_BYTES}

Common options:
  --url <url>                Target public http(s) URL.
  --id <id>                  Firecrawl crawl/extract job id.
  --format-name <name>       Add a Firecrawl output format. Repeatable. Default: markdown for scrape/crawl.
  --json-schema <json>       JSON Schema object for structured extraction.
  --schema-json <json>       Alias for --json-schema.
  --schema-file <path>       Read JSON Schema from a file.
  --prompt <text>            JSON extraction prompt.
  --system-prompt <text>     JSON extraction system prompt.
  --only-main-content <bool> Firecrawl onlyMainContent option. Default: true.
  --zero-data-retention      Request Firecrawl zero data retention when enabled for the team.

Crawl options:
  --limit <n>                Crawl page limit. Default: ${DEFAULT_CRAWL_LIMIT}, max: ${MAX_CRAWL_LIMIT}.
  --include-path <regex>     Include URL path regex. Repeatable.
  --exclude-path <regex>     Exclude URL path regex. Repeatable.
  --delay <ms>               Delay between requests.
  --max-concurrency <n>      Firecrawl maxConcurrency.
  --allow-subdomains         Allow subdomains.
  --allow-external-links     Allow external links.
  --crawl-entire-domain      Follow sibling and parent internal links.
  --robots-user-agent <ua>   User-Agent for robots.txt evaluation.

Map options:
  --search <query>           Rank map results by query.
  --sitemap include|skip|only
  --include-subdomains <bool>
  --ignore-query-parameters <bool>
  --ignore-cache
`.trim();
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const opts = {
    format: 'pretty',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
    formatNames: [],
    includePaths: [],
    excludePaths: [],
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const readValue = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        fail(`${arg} requires a value.`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case '--format':
        opts.format = readValue();
        break;
      case '--timeout-ms':
        opts.timeoutMs = parseInteger(readValue(), '--timeout-ms', 1, 600_000);
        break;
      case '--max-response-bytes':
        opts.maxResponseBytes = parseInteger(
          readValue(),
          '--max-response-bytes',
          1,
          50_000_000,
        );
        break;
      case '--url':
        opts.url = readValue();
        break;
      case '--id':
        opts.id = readValue();
        break;
      case '--format-name':
        opts.formatNames.push(readValue());
        break;
      case '--json-schema':
      case '--schema-json':
        opts.schemaJson = readValue();
        break;
      case '--schema-file':
        opts.schemaFile = readValue();
        break;
      case '--prompt':
        opts.prompt = readValue();
        break;
      case '--system-prompt':
        opts.systemPrompt = readValue();
        break;
      case '--only-main-content':
        opts.onlyMainContent = parseBoolean(readValue(), '--only-main-content');
        break;
      case '--zero-data-retention':
        opts.zeroDataRetention = true;
        break;
      case '--limit':
        opts.limit = parseInteger(readValue(), '--limit', 1, MAX_MAP_LIMIT);
        break;
      case '--include-path':
        opts.includePaths.push(readValue());
        break;
      case '--exclude-path':
        opts.excludePaths.push(readValue());
        break;
      case '--delay':
        opts.delay = parseInteger(readValue(), '--delay', 0, 60_000);
        break;
      case '--max-concurrency':
        opts.maxConcurrency = parseInteger(
          readValue(),
          '--max-concurrency',
          1,
          50,
        );
        break;
      case '--allow-subdomains':
        opts.allowSubdomains = true;
        break;
      case '--allow-external-links':
        opts.allowExternalLinks = true;
        break;
      case '--crawl-entire-domain':
        opts.crawlEntireDomain = true;
        break;
      case '--robots-user-agent':
        opts.robotsUserAgent = readValue();
        break;
      case '--search':
        opts.search = readValue();
        break;
      case '--sitemap':
        opts.sitemap = readValue();
        break;
      case '--include-subdomains':
        opts.includeSubdomains = parseBoolean(
          readValue(),
          '--include-subdomains',
        );
        break;
      case '--ignore-query-parameters':
        opts.ignoreQueryParameters = parseBoolean(
          readValue(),
          '--ignore-query-parameters',
        );
        break;
      case '--ignore-cache':
        opts.ignoreCache = true;
        break;
      case '--ignore-robots-txt':
        fail(
          '--ignore-robots-txt is intentionally unsupported by this skill; R53 requires robots.txt respect by default.',
        );
        break;
      default:
        fail(`Unknown option: ${arg}`);
    }
  }

  return { opts, positional };
}

function parseBoolean(value, label) {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  fail(`${label} must be true or false.`);
}

function parseInteger(value, label, min, max) {
  if (!/^\d+$/.test(String(value))) {
    fail(`${label} must be an integer between ${min} and ${max}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    fail(`${label} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function normalizeTargetUrl(value, { allowGlob = false } = {}) {
  if (!value) fail('--url is required.');
  const normalized = String(value).trim();
  if (!normalized) fail('--url is required.');
  const urlToParse = allowGlob
    ? normalized.replace(/[*{].*$/u, '') || normalized
    : normalized;
  let parsed;
  try {
    parsed = new URL(urlToParse);
  } catch {
    fail(
      allowGlob
        ? '--url must be a valid http(s) URL or URL glob.'
        : '--url must be a valid http(s) URL.',
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    fail('--url must use http or https.');
  }
  if (parsed.username || parsed.password) {
    fail('--url must not contain embedded credentials.');
  }
  return allowGlob ? normalized : parsed.toString();
}

function normalizeJobId(value, label = '--id') {
  const normalized = String(value || '').trim();
  if (!normalized) fail(`${label} is required.`);
  if (!/^[A-Za-z0-9_-]+$/u.test(normalized)) {
    fail(`${label} must contain only letters, numbers, "_" or "-".`);
  }
  return encodeURIComponent(normalized);
}

function parseJsonObject(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    fail(`${label} must be valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`${label} must be a JSON object.`);
  }
  return parsed;
}

function readSchema(opts) {
  if (opts.schemaJson && opts.schemaFile) {
    fail('Use either --schema-json or --schema-file, not both.');
  }
  if (opts.schemaJson) return parseJsonObject(opts.schemaJson, '--schema-json');
  if (!opts.schemaFile) return null;
  let raw;
  try {
    raw = fs.readFileSync(opts.schemaFile, 'utf-8');
  } catch (error) {
    fail(`Could not read --schema-file: ${error.message}`);
  }
  return parseJsonObject(raw, '--schema-file');
}

function normalizeFormatNames(opts, defaultFormats) {
  const values =
    opts.formatNames.length > 0 ? opts.formatNames : defaultFormats;
  const normalized = [];
  for (const value of values) {
    const trimmed = String(value || '').trim();
    if (!trimmed) fail('--format-name cannot be blank.');
    normalized.push(trimmed);
  }
  return normalized;
}

function scrapeOptions(opts, schema, defaults = ['markdown']) {
  const formats = normalizeFormatNames(opts, defaults);
  if (schema) {
    const format = { type: 'json', schema };
    if (opts.prompt) format.prompt = opts.prompt;
    if (opts.systemPrompt) format.systemPrompt = opts.systemPrompt;
    formats.push(format);
  }
  const body = {
    formats,
    onlyMainContent: opts.onlyMainContent !== false,
  };
  if (opts.zeroDataRetention) body.zeroDataRetention = true;
  return body;
}

function buildRequest(command, opts) {
  const baseUrl = DEFAULT_BASE_URL;
  const schema = readSchema(opts);
  const operation = normalizeCommand(command);
  let path;
  let method = 'POST';
  let json;

  if (operation === 'scrape.url') {
    const targetUrl = normalizeTargetUrl(opts.url);
    path = '/scrape';
    json = {
      url: targetUrl,
      ...scrapeOptions(opts, schema),
    };
  } else if (operation === 'extract.structured') {
    if (!schema) {
      fail('extract.structured requires --schema-json or --schema-file.');
    }
    const targetUrl = normalizeTargetUrl(opts.url, { allowGlob: true });
    path = '/extract';
    json = {
      urls: [targetUrl],
      schema,
      ignoreInvalidURLs: true,
      scrapeOptions: {
        formats: normalizeFormatNames(opts, ['markdown']),
        onlyMainContent: opts.onlyMainContent !== false,
      },
    };
    if (opts.prompt) json.prompt = opts.prompt;
    if (opts.systemPrompt) json.systemPrompt = opts.systemPrompt;
    if (opts.zeroDataRetention) json.zeroDataRetention = true;
  } else if (operation === 'crawl.site') {
    const targetUrl = normalizeTargetUrl(opts.url);
    path = '/crawl';
    const limit =
      opts.limit === undefined
        ? DEFAULT_CRAWL_LIMIT
        : parseInteger(opts.limit, '--limit', 1, MAX_CRAWL_LIMIT);
    json = {
      url: targetUrl,
      limit,
      ignoreRobotsTxt: false,
      scrapeOptions: scrapeOptions(opts, schema),
    };
    if (opts.includePaths.length) json.includePaths = opts.includePaths;
    if (opts.excludePaths.length) json.excludePaths = opts.excludePaths;
    if (opts.delay !== undefined) json.delay = opts.delay;
    if (opts.maxConcurrency !== undefined) {
      json.maxConcurrency = opts.maxConcurrency;
    }
    if (opts.allowSubdomains) json.allowSubdomains = true;
    if (opts.allowExternalLinks) json.allowExternalLinks = true;
    if (opts.crawlEntireDomain) json.crawlEntireDomain = true;
    if (opts.robotsUserAgent) json.robotsUserAgent = opts.robotsUserAgent;
    if (opts.zeroDataRetention) json.zeroDataRetention = true;
  } else if (operation === 'crawl.status') {
    path = `/crawl/${normalizeJobId(opts.id)}`;
    method = 'GET';
  } else if (operation === 'crawl.cancel') {
    path = `/crawl/${normalizeJobId(opts.id)}`;
    method = 'DELETE';
  } else if (operation === 'crawl.active') {
    path = '/crawl/active';
    method = 'GET';
  } else if (operation === 'map.site') {
    const targetUrl = normalizeTargetUrl(opts.url);
    path = '/map';
    const limit =
      opts.limit === undefined
        ? DEFAULT_MAP_LIMIT
        : parseInteger(opts.limit, '--limit', 1, MAX_MAP_LIMIT);
    json = {
      url: targetUrl,
      limit,
    };
    if (opts.search) json.search = opts.search;
    if (opts.sitemap !== undefined) {
      if (!['include', 'skip', 'only'].includes(opts.sitemap)) {
        fail('--sitemap must be one of include, skip, or only.');
      }
      json.sitemap = opts.sitemap;
    }
    if (opts.includeSubdomains !== undefined) {
      json.includeSubdomains = opts.includeSubdomains;
    }
    if (opts.ignoreQueryParameters !== undefined) {
      json.ignoreQueryParameters = opts.ignoreQueryParameters;
    }
    if (opts.ignoreCache) json.ignoreCache = true;
  } else if (operation === 'extract.status') {
    path = `/extract/${normalizeJobId(opts.id)}`;
    method = 'GET';
  } else {
    fail(`Unsupported Firecrawl operation: ${command}`);
  }

  const result = {
    command: 'http-request',
    adapter: 'firecrawl-managed',
    operation,
    httpRequest: {
      url: `${baseUrl}${path}`,
      method,
      bearerSecretName: SECRET_NAME,
      skillName: SKILL_NAME,
      timeoutMs: opts.timeoutMs,
      maxResponseBytes: opts.maxResponseBytes,
    },
  };
  if (json !== undefined) {
    result.httpRequest.json = json;
    result.costMeasurement = {
      system: 'UsageTotals',
      subLimitKey: 'firecrawl',
    };
  }
  return result;
}

function normalizeCommand(command) {
  return COMMAND_ALIASES.get(command) || command;
}

function main(argv = process.argv.slice(2)) {
  const { opts, positional } = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!['json', 'pretty'].includes(opts.format)) {
    fail('--format must be json or pretty.');
  }
  const mode = positional[0];
  const command = normalizeCommand(positional[1]);
  if (mode !== 'http-request') {
    fail('Expected command mode: http-request.');
  }
  if (!COMMANDS.has(command)) {
    fail(`Expected a Firecrawl operation: ${[...COMMANDS].join(', ')}.`);
  }

  const payload = buildRequest(command, opts);
  process.stdout.write(
    opts.format === 'json'
      ? `${JSON.stringify(payload)}\n`
      : `${JSON.stringify(payload, null, 2)}\n`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildRequest,
  main,
  parseArgs,
};
