#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

const DEFAULT_BASE_URL = 'https://hermes3000.ai/api';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4_000_000;
const SKILL_NAME = 'hermes3000-writing';
const EMAIL_SECRET = 'HERMES3000_EMAIL';
const PASSWORD_SECRET = 'HERMES3000_PASSWORD';
const JWT_SECRET = 'HERMES3000_JWT';

const COMMAND_ALIASES = new Map([
  ['login', 'auth.login'],
  ['create-book', 'books.create'],
  ['list-books', 'books.list'],
  ['get-book', 'books.get'],
  ['put-structure', 'structure.put'],
  ['generate-text', 'ai.generate-text'],
  ['save-content', 'content.save'],
  ['chapter-summary', 'consistency.chapter-summary'],
  ['update-story', 'consistency.update-story'],
  ['stats', 'books.stats'],
  ['export', 'export.download'],
]);

const COMMANDS = new Set([
  'auth.login',
  'books.create',
  'books.list',
  'books.get',
  'structure.put',
  'ai.generate-text',
  'content.save',
  'consistency.chapter-summary',
  'consistency.update-story',
  'books.stats',
  'export.download',
]);

function usage() {
  return `
Hermes3000 writing skill helper

Build gateway-proxied http_request payloads for the Hermes3000 API.

Usage:
  node skills/hermes3000-writing/scripts/hermes3000.cjs [--format json] http-request auth.login
  node skills/hermes3000-writing/scripts/hermes3000.cjs [--format json] http-request books.create --title "Draft" --book-type prose
  node skills/hermes3000-writing/scripts/hermes3000.cjs [--format json] http-request books.list
  node skills/hermes3000-writing/scripts/hermes3000.cjs [--format json] http-request books.get --book-id 42
  node skills/hermes3000-writing/scripts/hermes3000.cjs [--format json] http-request structure.put --book-id 42 --structure-type plot --content-file plot.md
  node skills/hermes3000-writing/scripts/hermes3000.cjs [--format json] http-request structure.put --book-id 42 --structure-type chapters --content-json '[{"id":"...","title":"Chapter 1","summary":"..."}]'
  node skills/hermes3000-writing/scripts/hermes3000.cjs [--format json] http-request ai.generate-text --book-id 42 --chapter-id "Chapter 1" --prompt "Write the opening scene"
  node skills/hermes3000-writing/scripts/hermes3000.cjs [--format json] http-request content.save --book-id 42 --chapter-uuid <uuid> --content-file chapter1.html
  node skills/hermes3000-writing/scripts/hermes3000.cjs [--format json] http-request consistency.chapter-summary --book-id 42 --chapter-id "Chapter 1" --chapter-content-file chapter1.html --lang en
  node skills/hermes3000-writing/scripts/hermes3000.cjs [--format json] http-request consistency.update-story --book-id 42
  node skills/hermes3000-writing/scripts/hermes3000.cjs [--format json] http-request books.stats --book-id 42
  node skills/hermes3000-writing/scripts/hermes3000.cjs [--format json] http-request export.download --book-id 42 --export-format docx

Global options:
  --format json|pretty       Output JSON or pretty-printed JSON. Default: pretty.
  --base-url <url>           Hermes3000 API base URL. Default: ${DEFAULT_BASE_URL}
  --timeout-ms <ms>          Gateway request timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --max-response-bytes <n>   Gateway response cap. Default: ${DEFAULT_MAX_RESPONSE_BYTES}

Secret contract:
  auth.login resolves <secret:${EMAIL_SECRET}> and <secret:${PASSWORD_SECRET}> in the gateway.
  auth.login captures response field "token" into ${JWT_SECRET}.
  Other operations use bearerSecretName: "${JWT_SECRET}".
`.trim();
}

function fail(message) {
  throw new Error(message);
}

function parseInteger(value, name, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    fail(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function parseArgs(argv) {
  const opts = {
    format: 'pretty',
    baseUrl: DEFAULT_BASE_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
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
      case '--base-url':
        opts.baseUrl = readValue();
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
      case '--book-id':
        opts.bookId = parseInteger(readValue(), '--book-id', 1, 10_000_000_000);
        break;
      case '--title':
        opts.title = readValue();
        break;
      case '--book-type':
        opts.bookType = readValue();
        break;
      case '--payment-id':
        opts.paymentId = parseInteger(readValue(), '--payment-id', 1, 10_000_000_000);
        break;
      case '--predecessor-book-id':
        opts.predecessorBookId = parseInteger(
          readValue(),
          '--predecessor-book-id',
          1,
          10_000_000_000,
        );
        break;
      case '--structure-type':
        opts.structureType = readValue();
        break;
      case '--content':
        opts.content = readValue();
        break;
      case '--content-file':
        opts.content = readTextFile(readValue());
        break;
      case '--content-json':
        opts.content = parseJson(readValue(), '--content-json');
        break;
      case '--chapter-id':
        opts.chapterId = readValue();
        break;
      case '--chapter-title':
        opts.chapterTitle = readValue();
        break;
      case '--chapter-uuid':
        opts.chapterUuid = readValue();
        break;
      case '--chapter-content':
        opts.chapterContent = readValue();
        break;
      case '--chapter-content-file':
        opts.chapterContent = readTextFile(readValue());
        break;
      case '--prompt':
        opts.prompt = readValue();
        break;
      case '--prompt-file':
        opts.prompt = readTextFile(readValue());
        break;
      case '--context':
        opts.context = readValue();
        break;
      case '--context-file':
        opts.context = readTextFile(readValue());
        break;
      case '--heading':
        opts.heading = readValue();
        break;
      case '--content-type':
        opts.contentType = readValue();
        break;
      case '--order-index':
        opts.orderIndex = parseInteger(readValue(), '--order-index', 0, 1_000_000);
        break;
      case '--narrative-order':
        opts.narrativeOrder = parseInteger(
          readValue(),
          '--narrative-order',
          0,
          1_000_000,
        );
        break;
      case '--lang':
        opts.lang = readValue();
        break;
      case '--export-format':
        opts.exportFormat = readValue();
        break;
      case '--normseite':
        opts.normseite = true;
        break;
      case '--uuid':
        opts.uuid = true;
        break;
      default:
        fail(`Unknown option: ${arg}`);
    }
  }

  opts.commandGroup = positional[0];
  opts.operation = COMMAND_ALIASES.get(positional[1]) || positional[1];
  return opts;
}

function readTextFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function parseJson(raw, optionName) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${optionName} must be valid JSON: ${error.message}`);
  }
}

function normalizeBaseUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    fail('--base-url must use http or https.');
  }
  return url.toString().replace(/\/+$/, '');
}

function requireBookId(opts) {
  if (!opts.bookId) fail('--book-id is required.');
  return opts.bookId;
}

function requireValue(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail(`${name} is required.`);
  return value;
}

function validateEnum(value, name, allowed) {
  if (!allowed.includes(value)) {
    fail(`${name} must be one of: ${allowed.join(', ')}.`);
  }
  return value;
}

function request(method, url, opts, extra = {}) {
  return {
    url,
    method,
    timeoutMs: opts.timeoutMs,
    maxResponseBytes: opts.maxResponseBytes,
    skillName: SKILL_NAME,
    ...extra,
  };
}

function authenticatedRequest(method, path, opts, extra = {}) {
  return request(method, `${normalizeBaseUrl(opts.baseUrl)}${path}`, opts, {
    bearerSecretName: JWT_SECRET,
    ...extra,
  });
}

function buildHttpRequest(opts) {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const op = opts.operation;
  if (!COMMANDS.has(op)) fail(`Unknown operation: ${op || '(missing)'}`);

  switch (op) {
    case 'auth.login':
      return request('POST', `${baseUrl}/auth/login`, opts, {
        json: {
          email: `<secret:${EMAIL_SECRET}>`,
          password: `<secret:${PASSWORD_SECRET}>`,
        },
        replaceSecretPlaceholders: true,
        captureResponseFields: [
          { jsonPath: 'token', secretName: JWT_SECRET },
        ],
      });
    case 'books.list':
      return authenticatedRequest('GET', '/books', opts);
    case 'books.create': {
      const bookType = validateEnum(
        opts.bookType || 'prose',
        '--book-type',
        ['prose', 'nonfiction', 'whitepaper'],
      );
      const json = {
        title: requireValue(opts.title, '--title'),
        bookType,
      };
      if (opts.paymentId) json.paymentId = opts.paymentId;
      if (opts.predecessorBookId) {
        json.predecessorBookId = opts.predecessorBookId;
      }
      return authenticatedRequest('POST', '/books', opts, { json });
    }
    case 'books.get':
      return authenticatedRequest('GET', `/books/${requireBookId(opts)}`, opts);
    case 'structure.put': {
      const structureType = validateEnum(
        requireValue(opts.structureType, '--structure-type'),
        '--structure-type',
        ['chapters', 'characters', 'plot', 'style', 'places_things', 'clipboard'],
      );
      if (opts.content === undefined) {
        fail('--content, --content-file, or --content-json is required.');
      }
      return authenticatedRequest('PUT', `/books/${requireBookId(opts)}/structure`, opts, {
        json: {
          structureType,
          content: opts.content,
        },
      });
    }
    case 'ai.generate-text': {
      const json = {
        bookId: requireBookId(opts),
        prompt: requireValue(opts.prompt, '--prompt'),
      };
      if (opts.chapterId) json.chapterId = opts.chapterId;
      if (opts.context) json.context = opts.context;
      return authenticatedRequest('POST', '/ai/generate-text', opts, { json });
    }
    case 'content.save': {
      requireBookId(opts);
      if (!opts.chapterUuid && !opts.chapterId) {
        fail('--chapter-uuid or --chapter-id is required.');
      }
      const json = {
        content: requireValue(opts.content, '--content or --content-file'),
        contentType: opts.contentType || 'text',
      };
      if (opts.chapterUuid) json.chapterUuid = opts.chapterUuid;
      if (opts.chapterId) json.chapterId = opts.chapterId;
      if (opts.heading) json.heading = opts.heading;
      if (opts.orderIndex !== undefined) json.orderIndex = opts.orderIndex;
      return authenticatedRequest('POST', `/books/${opts.bookId}/content`, opts, { json });
    }
    case 'consistency.chapter-summary': {
      const json = {
        bookId: requireBookId(opts),
        chapterId: requireValue(opts.chapterId, '--chapter-id'),
        chapterContent: requireValue(
          opts.chapterContent,
          '--chapter-content or --chapter-content-file',
        ),
      };
      if (opts.chapterTitle) json.chapterTitle = opts.chapterTitle;
      if (opts.chapterUuid) json.chapterUuid = opts.chapterUuid;
      if (opts.narrativeOrder !== undefined) {
        json.narrativeOrder = opts.narrativeOrder;
      }
      if (opts.lang) {
        json.lang = validateEnum(opts.lang, '--lang', ['de', 'en', 'fr', 'es']);
      }
      return authenticatedRequest('POST', '/consistency/chapter-summary', opts, { json });
    }
    case 'consistency.update-story':
      return authenticatedRequest('POST', '/consistency/update-story', opts, {
        json: { bookId: requireBookId(opts) },
      });
    case 'books.stats':
      return authenticatedRequest('GET', `/books/${requireBookId(opts)}/stats`, opts);
    case 'export.download': {
      const format = validateEnum(
        requireValue(opts.exportFormat, '--export-format'),
        '--export-format',
        ['pdf', 'docx', 'epub', 'html'],
      );
      const query = opts.normseite ? '?normseite=true' : '';
      return authenticatedRequest(
        'GET',
        `/books/${requireBookId(opts)}/download/${format}${query}`,
        opts,
      );
    }
    default:
      fail(`Unhandled operation: ${op}`);
  }
}

function buildOutput(opts) {
  if (opts.uuid) {
    return { uuid: crypto.randomUUID() };
  }
  if (opts.commandGroup !== 'http-request') {
    fail('Expected command group: http-request.');
  }
  return {
    command: 'http-request',
    adapter: 'hermes3000',
    operation: opts.operation,
    httpRequest: buildHttpRequest(opts),
    secrets: {
      loginInputs: [EMAIL_SECRET, PASSWORD_SECRET],
      bearerToken: JWT_SECRET,
    },
  };
}

function printOutput(value, format) {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  } else if (format === 'pretty') {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    fail('--format must be json or pretty.');
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }
  printOutput(buildOutput(opts), opts.format);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
