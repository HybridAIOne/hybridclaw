#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const API_BASE_URL = 'https://api.miro.com/v2';
const OAUTH_AUTHORIZE_URL = 'https://miro.com/oauth/authorize';
const OAUTH_TOKEN_URL = 'https://api.miro.com/v1/oauth/token';
const SKILL_NAME = 'miro';
const ACCESS_TOKEN_SECRET = 'MIRO_ACCESS_TOKEN';
const DISCOVERY_TOKEN_SECRET = 'MIRO_DISCOVERY_ACCESS_TOKEN';
const CLIENT_ID_SECRET = 'MIRO_CLIENT_ID';
const CLIENT_SECRET_SECRET = 'MIRO_CLIENT_SECRET';
const OAUTH_CODE_SECRET = 'MIRO_OAUTH_CODE';
const REFRESH_TOKEN_SECRET = 'MIRO_REFRESH_TOKEN';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 500_000_000;
const DEFAULT_OUTPUT_DIR = '.generated-miro';
const BOARD_WRITE_GRANT = 'approve-miro-board-write';
const EXPORT_GRANT = 'approve-miro-export';
const DEFAULT_OAUTH_SCOPES = ['boards:read', 'boards:write'];

const SECRET_FLAGS = new Set([
  '--access-token',
  '--api-key',
  '--authorization',
  '--bearer',
  '--client-secret',
  '--discovery-token',
  '--oauth-token',
  '--password',
  '--refresh-token',
  '--token',
]);

const ITEM_TYPES = new Map([
  ['sticky_note', 'sticky_notes'],
  ['sticky-note', 'sticky_notes'],
  ['sticky_notes', 'sticky_notes'],
  ['text', 'texts'],
  ['texts', 'texts'],
  ['shape', 'shapes'],
  ['shapes', 'shapes'],
  ['connector', 'connectors'],
  ['connectors', 'connectors'],
  ['frame', 'frames'],
  ['frames', 'frames'],
]);

const ITEM_CREATE_OPERATIONS = new Map([
  ['create-sticky-note', 'sticky_notes'],
  ['create-text', 'texts'],
  ['create-shape', 'shapes'],
  ['create-connector', 'connectors'],
  ['create-frame', 'frames'],
]);

const ITEM_UPDATE_OPERATIONS = new Map([
  ['update-sticky-note', 'sticky_notes'],
  ['update-text', 'texts'],
  ['update-shape', 'shapes'],
  ['update-connector', 'connectors'],
  ['update-frame', 'frames'],
]);

const READ_OPERATIONS = new Set([
  'list-boards',
  'get-board',
  'list-items',
  'get-item',
  'export-status',
  'export-results',
  'export-tasks',
  'oauth-exchange-code',
  'oauth-refresh-token',
]);

const WRITE_OPERATIONS = new Set([
  ...ITEM_CREATE_OPERATIONS.keys(),
  ...ITEM_UPDATE_OPERATIONS.keys(),
]);

const EXPORT_WRITE_OPERATIONS = new Set(['export-create', 'export-link']);

function usage() {
  return `
Miro skill helper

Build gateway-proxied http_request payloads for Miro REST API v2 board reads,
guarded board writes, and Enterprise board export workflows.

Usage:
  node skills/miro/miro.cjs --format json plan "summarize this board"
  node skills/miro/miro.cjs --format json http-request list-boards --query roadmap --limit 20
  node skills/miro/miro.cjs --format json oauth authorize-url --client-id <client-id> --redirect-uri <uri> --scope boards:read --scope boards:write
  node skills/miro/miro.cjs --format json http-request oauth-exchange-code --redirect-uri <uri>
  node skills/miro/miro.cjs --format json http-request oauth-refresh-token
  node skills/miro/miro.cjs --format json http-request get-board --board-id <board-id>
  node skills/miro/miro.cjs --format json http-request list-items --board-id <board-id> --type sticky_note --limit 50
  node skills/miro/miro.cjs --format json http-request get-item --board-id <board-id> --type sticky_note --item-id <item-id>
  node skills/miro/miro.cjs --format json --request http-request create-sticky-note --board-id <board-id> --content "Decision" --x 0 --y 0
  node skills/miro/miro.cjs --format json approval-plan update-text --board-id <board-id> --item-id <item-id> --content "New text"
  node skills/miro/miro.cjs --format json http-request update-text --board-id <board-id> --item-id <item-id> --content "New text" --operator-grant ${BOARD_WRITE_GRANT}
  node skills/miro/miro.cjs --format json approval-plan export-create --org-id <org-id> --board-id <board-id> --request-id <uuid> --board-format PDF
  node skills/miro/miro.cjs --format json http-request export-status --org-id <org-id> --job-id <job-id>
  node skills/miro/miro.cjs --format json capture-export --export-url https://.../board.zip --filename board.zip
  node skills/miro/miro.cjs --format json explain-error --status 401 --message "MIRO_ACCESS_TOKEN is missing"

Global options:
  --format json|pretty       Output JSON or pretty-printed JSON. Default: pretty.
  --request                  Preview/dry-run mode for guarded writes. Emits the request object without requiring an operator grant.
  --timeout-ms <ms>          Gateway request timeout. Default: ${DEFAULT_TIMEOUT_MS}.
  --max-response-bytes <n>   Gateway response cap. Default: ${DEFAULT_MAX_RESPONSE_BYTES}.

Read options:
  --query <text>             Board search query.
  --team-id <id>             Miro team id for board search.
  --project-id <id>          Miro project/space id for board search.
  --sort <name>              Board sort: default, last_modified, last_opened, last_created, alphabetically.
  --offset <n>               Board search offset. Default: 0.
  --limit <n>                Result limit. Boards: 1-50; items: 10-50; export tasks: 1-500.
  --cursor <cursor>          Cursor for item/export pagination.
  --type <item-type>         sticky_note, text, shape, connector, or frame.

Write options:
  --board-id <id>            Target board id.
  --item-id <id>             Target item id for updates.
  --content <html-or-text>   Item content for sticky notes, text, or shapes.
  --title <text>             Frame title or item title.
  --shape <name>             Sticky note, shape, or connector shape.
  --x <n> --y <n>            Board position coordinates.
  --origin <name>            Position origin, usually center.
  --width <n> --height <n>   Geometry dimensions.
  --parent-id <id|null>      Parent frame id, or null/canvas for board canvas.
  --data-json <json>         Merge explicit data object.
  --style-json <json>        Merge explicit style object.
  --position-json <json>     Merge explicit position object.
  --geometry-json <json>     Merge explicit geometry object.
  --payload-json <json>      Full request JSON body escape hatch for supported operations.
  --start-item-id <id>       Connector start item id.
  --end-item-id <id>         Connector end item id.
  --start-snap-to <value>    Connector start snap point. Default: auto.
  --end-snap-to <value>      Connector end snap point. Default: auto.
  --captions-json <json>     Connector captions array.
  --operator-grant <grant>   Required grant for guarded writes.

Export options:
  --org-id <id>              Miro organization id for Enterprise export APIs.
  --request-id <uuid>        Idempotency UUID for export-create.
  --job-id <uuid>            Export job id.
  --task-id <uuid>           Export task id for export-link.
  --board-id <id>            Board id. Repeatable for export-create.
  --board-format SVG|HTML|PDF
  --export-url <url>         HTTPS exportLink from Miro export results.
  --output-dir <path>        Workspace-relative output dir. Default: ${DEFAULT_OUTPUT_DIR}.
  --filename <name>          Optional export artifact filename.
  --max-download-bytes <n>   Export download cap. Default: ${DEFAULT_MAX_DOWNLOAD_BYTES}.

OAuth options:
  --client-id <id>           Miro app client id for authorize-url only.
  --client-id-secret <name>  Secret holding client id. Default: ${CLIENT_ID_SECRET}.
  --client-secret-secret <name>
                              Secret holding client secret. Default: ${CLIENT_SECRET_SECRET}.
  --code-secret <name>       Secret holding authorization code. Default: ${OAUTH_CODE_SECRET}.
  --refresh-token-secret <name>
                              Secret holding refresh token. Default: ${REFRESH_TOKEN_SECRET}.
  --redirect-uri <uri>       Redirect URI configured in the Miro app.
  --scope <scope>            OAuth scope. Repeatable. Default: ${DEFAULT_OAUTH_SCOPES.join(' ')}.
  --state <state>            Optional caller-managed OAuth state.

Operations:
  Reads: list-boards, get-board, list-items, get-item, export-status, export-results, export-tasks, oauth-exchange-code, oauth-refresh-token
  Writes: create-sticky-note, update-sticky-note, create-text, update-text, create-shape, update-shape, create-connector, update-connector, create-frame, update-frame
  Exports: export-create, export-link
  Local artifact capture: capture-export

Credentials are injected server-side with bearerSecretName. Do not pass raw
Miro tokens on the command line. Store secrets with:
  hybridclaw secret set ${ACCESS_TOKEN_SECRET} "<oauth-or-access-token>"
  hybridclaw secret set ${DISCOVERY_TOKEN_SECRET} "<enterprise-discovery-token>"
  hybridclaw secret set ${CLIENT_ID_SECRET} "<miro-client-id>"
  hybridclaw secret set ${CLIENT_SECRET_SECRET} "<miro-client-secret>"
  hybridclaw secret set ${OAUTH_CODE_SECRET} "<one-time-code>"
`.trim();
}

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function printJson(payload, format = 'pretty') {
  const indent = format === 'pretty' ? 2 : undefined;
  process.stdout.write(`${JSON.stringify(payload, null, indent)}\n`);
}

function parseGlobalArgs(argv) {
  const opts = {
    format: 'pretty',
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
    rejectSecretFlag(arg);
    if (arg === '--request') {
      opts.request = true;
      continue;
    }
    if (['--format', '--timeout-ms', '--max-response-bytes'].includes(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--') || !String(value).trim()) {
        fail(`${arg} requires a value.`);
      }
      if (arg === '--format') {
        if (!['json', 'pretty'].includes(value)) {
          fail('--format must be json or pretty.');
        }
        opts.format = value;
      } else if (arg === '--timeout-ms') {
        opts.timeoutMs = parseInteger(value, '--timeout-ms', 1, 600_000);
      } else {
        opts.maxResponseBytes = parseInteger(
          value,
          '--max-response-bytes',
          1,
          50_000_000,
        );
      }
      index += 1;
      continue;
    }
    positional.push(arg);
  }

  return { opts, positional };
}

function parseCommandOptions(args) {
  const opts = {
    boardIds: [],
    scopes: [],
  };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    rejectSecretFlag(arg);
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const readValue = () => {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--') || !String(value).trim()) {
        fail(`${arg} requires a value.`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case '--board-id':
        opts.boardIds.push(readValue());
        break;
      case '--limit':
      case '--offset':
      case '--timeout-ms':
      case '--max-response-bytes':
      case '--max-download-bytes':
        opts[toCamel(arg.slice(2))] = readValue();
        break;
      case '--x':
      case '--y':
      case '--width':
      case '--height':
        opts[toCamel(arg.slice(2))] = parseFiniteNumber(readValue(), arg);
        break;
      case '--query':
      case '--team-id':
      case '--project-id':
      case '--sort':
      case '--cursor':
      case '--type':
      case '--item-id':
      case '--content':
      case '--title':
      case '--shape':
      case '--origin':
      case '--parent-id':
      case '--data-json':
      case '--style-json':
      case '--position-json':
      case '--geometry-json':
      case '--payload-json':
      case '--start-item-id':
      case '--end-item-id':
      case '--start-snap-to':
      case '--end-snap-to':
      case '--captions-json':
      case '--operator-grant':
      case '--org-id':
      case '--request-id':
      case '--job-id':
      case '--task-id':
      case '--board-format':
      case '--status':
      case '--message':
      case '--body-json':
      case '--export-url':
      case '--output-dir':
      case '--filename':
      case '--client-id':
      case '--client-id-secret':
      case '--client-secret-secret':
      case '--code-secret':
      case '--refresh-token-secret':
      case '--redirect-uri':
      case '--state':
        opts[toCamel(arg.slice(2))] = readValue();
        break;
      case '--scope':
        opts.scopes.push(readValue());
        break;
      default:
        fail(`Unknown option: ${arg}`);
    }
  }

  return { opts, positional };
}

function rejectSecretFlag(arg) {
  const name = String(arg || '').split('=')[0];
  if (SECRET_FLAGS.has(name)) {
    fail(
      `${name} is not accepted. Store Miro credentials as HybridClaw runtime secrets and let the helper emit bearerSecretName.`,
    );
  }
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function requireText(value, label) {
  const text = String(value || '').trim();
  if (!text) {
    fail(`${label} is required.`);
  }
  return text;
}

function parseInteger(value, label, min, max) {
  const text = String(value || '').trim();
  if (!/^\d+$/.test(text)) {
    fail(`${label} must be an integer between ${min} and ${max}.`);
  }
  const parsed = Number.parseInt(text, 10);
  if (parsed < min || parsed > max) {
    fail(`${label} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function parseFiniteNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    fail(`${label} must be a finite number.`);
  }
  return parsed;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`${label} must be valid JSON: ${error.message}`);
  }
}

function parseSecretName(value, label) {
  const text = requireText(value, label);
  if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(text)) {
    fail(`${label} must be an uppercase runtime secret name.`);
  }
  return text;
}

function pathSegment(value) {
  return encodeURIComponent(requireText(value, 'path segment'));
}

function appendQuery(url, params) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    searchParams.set(key, String(value));
  }
  const query = searchParams.toString();
  return query ? `${url}?${query}` : url;
}

function standardRequest(globalOpts, method, url, json) {
  const request = {
    url,
    method,
    bearerSecretName: ACCESS_TOKEN_SECRET,
    skillName: SKILL_NAME,
    timeoutMs: globalOpts.timeoutMs,
    maxResponseBytes: globalOpts.maxResponseBytes,
    headers: {
      accept: 'application/json',
    },
  };
  if (json !== undefined) {
    request.headers['content-type'] = 'application/json';
    request.json = json;
  }
  return request;
}

function discoveryRequest(globalOpts, method, url, json) {
  const request = standardRequest(globalOpts, method, url, json);
  request.bearerSecretName = DISCOVERY_TOKEN_SECRET;
  return request;
}

function buildHttpPayload(operation, commandOpts, globalOpts, mode = 'execute') {
  if (!operation) {
    fail('http-request requires an operation.');
  }

  const dryRun = globalOpts.request || mode === 'preview';
  const isBoardWrite = WRITE_OPERATIONS.has(operation);
  const isExportWrite = EXPORT_WRITE_OPERATIONS.has(operation);
  const requiredGrant = isBoardWrite
    ? BOARD_WRITE_GRANT
    : isExportWrite
      ? EXPORT_GRANT
      : undefined;

  if (requiredGrant && !dryRun && commandOpts.operatorGrant !== requiredGrant) {
    fail(
      `Operation ${operation} requires --operator-grant ${requiredGrant}. Run approval-plan or --request first for a preview.`,
    );
  }

  const httpRequest = buildRequestForOperation(operation, commandOpts, globalOpts);
  const liveExecution = httpRequest.liveExecution;
  delete httpRequest.liveExecution;

  const payload = {
    command: 'http-request',
    operation,
    stakesTier: requiredGrant ? 'amber' : 'green',
    requiredScopes: scopesFor(operation),
    dryRun,
    httpRequest,
    costMeasurement: {
      system: 'UsageTotals',
      subLimitKey: 'miro',
    },
  };

  if (requiredGrant) {
    payload.requiredGrant = requiredGrant;
    payload.requiresOperatorApproval = true;
  }
  if (liveExecution) {
    payload.liveExecution = liveExecution;
  }

  return payload;
}

function buildRequestForOperation(operation, opts, globalOpts) {
  if (operation === 'list-boards') {
    const limit =
      opts.limit === undefined
        ? undefined
        : parseInteger(opts.limit, '--limit', 1, 50);
    const offset =
      opts.offset === undefined
        ? undefined
        : parseInteger(opts.offset, '--offset', 0, 100_000);
    const sort = normalizeSort(opts.sort);
    const url = appendQuery(`${API_BASE_URL}/boards`, {
      query: opts.query,
      team_id: opts.teamId,
      project_id: opts.projectId,
      sort,
      limit,
      offset,
    });
    return standardRequest(globalOpts, 'GET', url);
  }

  if (operation === 'oauth-exchange-code') {
    const redirectUri = requireText(opts.redirectUri, '--redirect-uri');
    const clientIdSecret = parseSecretName(
      opts.clientIdSecret || CLIENT_ID_SECRET,
      '--client-id-secret',
    );
    const clientSecretSecret = parseSecretName(
      opts.clientSecretSecret || CLIENT_SECRET_SECRET,
      '--client-secret-secret',
    );
    const codeSecret = parseSecretName(
      opts.codeSecret || OAUTH_CODE_SECRET,
      '--code-secret',
    );
    return oauthTokenRequest(globalOpts, {
      grantType: 'authorization_code',
      body: {
        grant_type: 'authorization_code',
        client_id: `<secret:${clientIdSecret}>`,
        client_secret: `<secret:${clientSecretSecret}>`,
        code: `<secret:${codeSecret}>`,
        redirect_uri: redirectUri,
      },
      requiresConfiguredSecrets: [clientIdSecret, clientSecretSecret, codeSecret],
    });
  }

  if (operation === 'oauth-refresh-token') {
    const clientIdSecret = parseSecretName(
      opts.clientIdSecret || CLIENT_ID_SECRET,
      '--client-id-secret',
    );
    const clientSecretSecret = parseSecretName(
      opts.clientSecretSecret || CLIENT_SECRET_SECRET,
      '--client-secret-secret',
    );
    const refreshTokenSecret = parseSecretName(
      opts.refreshTokenSecret || REFRESH_TOKEN_SECRET,
      '--refresh-token-secret',
    );
    return oauthTokenRequest(globalOpts, {
      grantType: 'refresh_token',
      body: {
        grant_type: 'refresh_token',
        client_id: `<secret:${clientIdSecret}>`,
        client_secret: `<secret:${clientSecretSecret}>`,
        refresh_token: `<secret:${refreshTokenSecret}>`,
      },
      requiresConfiguredSecrets: [
        clientIdSecret,
        clientSecretSecret,
        refreshTokenSecret,
      ],
    });
  }

  if (operation === 'get-board') {
    const boardId = firstBoardId(opts);
    return standardRequest(
      globalOpts,
      'GET',
      `${API_BASE_URL}/boards/${pathSegment(boardId)}`,
    );
  }

  if (operation === 'list-items') {
    const boardId = firstBoardId(opts);
    const limit =
      opts.limit === undefined
        ? undefined
        : parseInteger(opts.limit, '--limit', 10, 50);
    const itemType = normalizeItemTypeForQuery(opts.type);
    const url = appendQuery(`${API_BASE_URL}/boards/${pathSegment(boardId)}/items`, {
      limit,
      cursor: opts.cursor,
      type: itemType,
    });
    return standardRequest(globalOpts, 'GET', url);
  }

  if (operation === 'get-item') {
    const boardId = firstBoardId(opts);
    const itemId = requireText(opts.itemId, '--item-id');
    const collection = collectionForType(opts.type);
    return standardRequest(
      globalOpts,
      'GET',
      `${API_BASE_URL}/boards/${pathSegment(boardId)}/${collection}/${pathSegment(
        itemId,
      )}`,
    );
  }

  if (ITEM_CREATE_OPERATIONS.has(operation)) {
    const boardId = firstBoardId(opts);
    const collection = ITEM_CREATE_OPERATIONS.get(operation);
    return standardRequest(
      globalOpts,
      'POST',
      `${API_BASE_URL}/boards/${pathSegment(boardId)}/${collection}`,
      buildItemBody(operation, opts, true),
    );
  }

  if (ITEM_UPDATE_OPERATIONS.has(operation)) {
    const boardId = firstBoardId(opts);
    const itemId = requireText(opts.itemId, '--item-id');
    const collection = ITEM_UPDATE_OPERATIONS.get(operation);
    return standardRequest(
      globalOpts,
      'PATCH',
      `${API_BASE_URL}/boards/${pathSegment(boardId)}/${collection}/${pathSegment(
        itemId,
      )}`,
      buildItemBody(operation, opts, false),
    );
  }

  if (operation === 'export-create') {
    const orgId = requireText(opts.orgId, '--org-id');
    const requestId = requireUuid(opts.requestId, '--request-id');
    const boardIds = opts.boardIds.map((id) => requireText(id, '--board-id'));
    if (boardIds.length === 0) {
      fail('--board-id is required for export-create and may be repeated.');
    }
    if (boardIds.length > 1000) {
      fail('export-create supports at most 1000 --board-id values.');
    }
    const boardFormat = normalizeBoardFormat(opts.boardFormat);
    const url = appendQuery(
      `${API_BASE_URL}/orgs/${pathSegment(orgId)}/boards/export/jobs`,
      { request_id: requestId },
    );
    return discoveryRequest(globalOpts, 'POST', url, {
      boardIds,
      boardFormat,
    });
  }

  if (operation === 'export-status') {
    const orgId = requireText(opts.orgId, '--org-id');
    const jobId = requireUuid(opts.jobId, '--job-id');
    return discoveryRequest(
      globalOpts,
      'GET',
      `${API_BASE_URL}/orgs/${pathSegment(orgId)}/boards/export/jobs/${pathSegment(
        jobId,
      )}`,
    );
  }

  if (operation === 'export-results') {
    const orgId = requireText(opts.orgId, '--org-id');
    const jobId = requireUuid(opts.jobId, '--job-id');
    return discoveryRequest(
      globalOpts,
      'GET',
      `${API_BASE_URL}/orgs/${pathSegment(orgId)}/boards/export/jobs/${pathSegment(
        jobId,
      )}/results`,
    );
  }

  if (operation === 'export-tasks') {
    const orgId = requireText(opts.orgId, '--org-id');
    const jobId = requireUuid(opts.jobId, '--job-id');
    const limit =
      opts.limit === undefined
        ? undefined
        : parseInteger(opts.limit, '--limit', 1, 500);
    const url = appendQuery(
      `${API_BASE_URL}/orgs/${pathSegment(orgId)}/boards/export/jobs/${pathSegment(
        jobId,
      )}/tasks`,
      { cursor: opts.cursor, limit },
    );
    return discoveryRequest(globalOpts, 'GET', url);
  }

  if (operation === 'export-link') {
    const orgId = requireText(opts.orgId, '--org-id');
    const jobId = requireUuid(opts.jobId, '--job-id');
    const taskId = requireUuid(opts.taskId, '--task-id');
    return discoveryRequest(
      globalOpts,
      'POST',
      `${API_BASE_URL}/orgs/${pathSegment(orgId)}/boards/export/jobs/${pathSegment(
        jobId,
      )}/tasks/${pathSegment(taskId)}/export-link`,
    );
  }

  fail(`Unsupported operation: ${operation}`);
}

function oauthTokenRequest(globalOpts, params) {
  return {
    url: OAUTH_TOKEN_URL,
    method: 'POST',
    skillName: SKILL_NAME,
    timeoutMs: globalOpts.timeoutMs,
    maxResponseBytes: 200_000,
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params.body).toString(),
    replaceSecretPlaceholders: true,
    captureResponseFields: [
      { jsonPath: 'access_token', secretName: ACCESS_TOKEN_SECRET },
      { jsonPath: 'refresh_token', secretName: REFRESH_TOKEN_SECRET },
    ],
    liveExecution: {
      mode: `miro-oauth-${params.grantType}`,
      requiresConfiguredSecrets: params.requiresConfiguredSecrets,
      capturesSecrets: [ACCESS_TOKEN_SECRET, REFRESH_TOKEN_SECRET],
    },
  };
}

function buildAuthorizeUrl(opts) {
  const clientId = requireText(opts.clientId, '--client-id');
  const redirectUri = requireText(opts.redirectUri, '--redirect-uri');
  const scopes = normalizeScopes(opts.scopes);
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
  });
  if (opts.state !== undefined) {
    query.set('state', requireText(opts.state, '--state'));
  }
  return {
    command: 'oauth',
    operation: 'authorize-url',
    authorizationUrl: `${OAUTH_AUTHORIZE_URL}?${query.toString()}`,
    scopes,
    next: {
      storeCode: `hybridclaw secret set ${OAUTH_CODE_SECRET} "<authorization-code>"`,
      exchangeCommand:
        'node skills/miro/miro.cjs --format json http-request oauth-exchange-code --redirect-uri "<same-redirect-uri>"',
    },
  };
}

function normalizeScopes(values) {
  const rawValues = values && values.length > 0 ? values : DEFAULT_OAUTH_SCOPES;
  const scopes = [];
  const seen = new Set();
  for (const value of rawValues) {
    for (const scope of String(value || '').split(/[,\s]+/)) {
      const trimmed = scope.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      scopes.push(trimmed);
    }
  }
  if (scopes.length === 0) {
    fail('At least one --scope is required.');
  }
  return scopes;
}

function firstBoardId(opts) {
  return requireText(opts.boardIds[0], '--board-id');
}

function normalizeSort(value) {
  if (value === undefined) {
    return undefined;
  }
  const normalized = String(value).trim();
  const allowed = new Set([
    'default',
    'last_modified',
    'last_opened',
    'last_created',
    'alphabetically',
  ]);
  if (!allowed.has(normalized)) {
    fail(
      '--sort must be default, last_modified, last_opened, last_created, or alphabetically.',
    );
  }
  return normalized;
}

function normalizeItemTypeForQuery(value) {
  if (value === undefined) {
    return undefined;
  }
  const normalized = String(value).trim();
  if (!ITEM_TYPES.has(normalized)) {
    fail('--type must be sticky_note, text, shape, connector, or frame.');
  }
  if (normalized === 'sticky-note' || normalized === 'sticky_notes') {
    return 'sticky_note';
  }
  if (normalized.endsWith('s')) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function collectionForType(value) {
  const normalized = requireText(value, '--type');
  const collection = ITEM_TYPES.get(normalized);
  if (!collection) {
    fail('--type must be sticky_note, text, shape, connector, or frame.');
  }
  return collection;
}

function normalizeBoardFormat(value) {
  if (value === undefined) {
    return 'SVG';
  }
  const normalized = String(value).trim().toUpperCase();
  if (!['SVG', 'HTML', 'PDF'].includes(normalized)) {
    fail('--board-format must be SVG, HTML, or PDF.');
  }
  return normalized;
}

function requireUuid(value, label) {
  const text = requireText(value, label);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      text,
    )
  ) {
    fail(`${label} must be a UUID.`);
  }
  return text;
}

function buildItemBody(operation, opts, isCreate) {
  if (opts.payloadJson) {
    const payload = parseJson(opts.payloadJson, '--payload-json');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      fail('--payload-json must be a JSON object.');
    }
    return payload;
  }

  if (operation.includes('connector')) {
    return buildConnectorBody(opts, isCreate);
  }

  const body = {};
  const data = {};

  if (opts.content !== undefined) {
    data.content = opts.content;
  }
  if (opts.title !== undefined) {
    data.title = opts.title;
  }
  if (opts.shape !== undefined) {
    data.shape = opts.shape;
  }

  if (operation === 'create-frame' || operation === 'update-frame') {
    if (opts.boardFormat !== undefined) {
      data.format = normalizeBoardFormat(opts.boardFormat);
    }
  }

  if (opts.dataJson) {
    Object.assign(data, parseObject(opts.dataJson, '--data-json'));
  }
  if (Object.keys(data).length > 0) {
    body.data = data;
  }

  if (opts.styleJson) {
    body.style = parseObject(opts.styleJson, '--style-json');
  }

  const position = {};
  if (opts.x !== undefined) {
    position.x = opts.x;
  }
  if (opts.y !== undefined) {
    position.y = opts.y;
  }
  if (opts.origin !== undefined) {
    position.origin = opts.origin;
  }
  if (opts.positionJson) {
    Object.assign(position, parseObject(opts.positionJson, '--position-json'));
  }
  if (Object.keys(position).length > 0) {
    body.position = position;
  }

  const geometry = {};
  if (opts.width !== undefined) {
    geometry.width = opts.width;
  }
  if (opts.height !== undefined) {
    geometry.height = opts.height;
  }
  if (opts.geometryJson) {
    Object.assign(geometry, parseObject(opts.geometryJson, '--geometry-json'));
  }
  if (Object.keys(geometry).length > 0) {
    body.geometry = geometry;
  }

  if (opts.parentId !== undefined) {
    const parentText = String(opts.parentId).trim().toLowerCase();
    body.parent =
      parentText === 'null' || parentText === 'canvas'
        ? { id: null }
        : { id: opts.parentId };
  }

  requireMinimumItemBody(operation, body, isCreate);
  return body;
}

function buildConnectorBody(opts, isCreate) {
  const body = {};

  if (opts.startItemId !== undefined) {
    body.startItem = {
      id: opts.startItemId,
      snapTo: opts.startSnapTo || 'auto',
    };
  }
  if (opts.endItemId !== undefined) {
    body.endItem = {
      id: opts.endItemId,
      snapTo: opts.endSnapTo || 'auto',
    };
  }
  if (opts.shape !== undefined) {
    const normalizedShape = String(opts.shape).trim();
    if (!['straight', 'elbowed', 'curved'].includes(normalizedShape)) {
      fail('--shape for connectors must be straight, elbowed, or curved.');
    }
    body.shape = normalizedShape;
  }
  if (opts.captionsJson) {
    const captions = parseJson(opts.captionsJson, '--captions-json');
    if (!Array.isArray(captions)) {
      fail('--captions-json must be a JSON array.');
    }
    body.captions = captions;
  }
  if (opts.styleJson) {
    body.style = parseObject(opts.styleJson, '--style-json');
  }
  if (opts.dataJson) {
    Object.assign(body, parseObject(opts.dataJson, '--data-json'));
  }

  if (isCreate) {
    if (!body.startItem) {
      fail('--start-item-id is required for create-connector unless --payload-json is used.');
    }
    if (!body.endItem) {
      fail('--end-item-id is required for create-connector unless --payload-json is used.');
    }
    if (body.startItem.id === body.endItem.id) {
      fail('--start-item-id and --end-item-id must be different.');
    }
  }
  if (Object.keys(body).length === 0) {
    fail('At least one connector field is required for update-connector.');
  }
  return body;
}

function parseObject(value, label) {
  const parsed = parseJson(value, label);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`${label} must be a JSON object.`);
  }
  return parsed;
}

function requireMinimumItemBody(operation, body, isCreate) {
  if (!isCreate) {
    if (Object.keys(body).length === 0) {
      fail(`At least one field is required for ${operation}.`);
    }
    return;
  }

  if (operation === 'create-sticky-note' && !body.data?.content) {
    fail('--content is required for create-sticky-note unless --payload-json or --data-json provides data.content.');
  }
  if (operation === 'create-text' && !body.data?.content) {
    fail('--content is required for create-text unless --payload-json or --data-json provides data.content.');
  }
  if (operation === 'create-shape' && !body.data?.shape) {
    fail('--shape is required for create-shape unless --payload-json or --data-json provides data.shape.');
  }
  if (operation === 'create-frame' && !body.data?.title) {
    fail('--title is required for create-frame unless --payload-json or --data-json provides data.title.');
  }
}

function scopesFor(operation) {
  if (operation.startsWith('export-')) {
    return ['boards:export'];
  }
  if (operation.startsWith('oauth-')) {
    return ['oauth'];
  }
  if (WRITE_OPERATIONS.has(operation)) {
    return ['boards:write'];
  }
  return ['boards:read'];
}

function plan(text) {
  const normalized = String(text || '').toLowerCase();
  if (/\b(export|snapshot|archive|ediscovery|discovery)\b/.test(normalized)) {
    return {
      command: 'plan',
      operation: 'export-create',
      stakesTier: 'amber',
      requiredGrant: EXPORT_GRANT,
      requiredScopes: ['boards:export'],
      nextStep:
        'Build an approval-plan for export-create with org id, board id, request UUID, and board format.',
    };
  }
  if (/\b(create|add|update|edit|move|resize|connect|draw|write)\b/.test(normalized)) {
    return {
      command: 'plan',
      operation: 'board-write',
      stakesTier: 'amber',
      requiredGrant: BOARD_WRITE_GRANT,
      requiredScopes: ['boards:write'],
      nextStep:
        'Run approval-plan for the exact create/update operation, then wait for operator confirmation.',
    };
  }
  return {
    command: 'plan',
    operation: 'board-read',
    stakesTier: 'green',
    requiredScopes: ['boards:read'],
    nextStep:
      'Use list-boards, get-board, list-items, or get-item through http-request.',
  };
}

function approvalPlan(operation, commandOpts, globalOpts, rawArgs) {
  if (!WRITE_OPERATIONS.has(operation) && !EXPORT_WRITE_OPERATIONS.has(operation)) {
    fail(`approval-plan only supports guarded write/export operations. ${operation} is ${READ_OPERATIONS.has(operation) ? 'read-only' : 'unsupported'}.`);
  }
  const preview = buildHttpPayload(operation, commandOpts, globalOpts, 'preview');
  const requiredGrant = preview.requiredGrant;
  const approvedCommand = [
    'node',
    'skills/miro/miro.cjs',
    '--format',
    'json',
    'http-request',
    ...rawArgs,
    '--operator-grant',
    requiredGrant,
  ];
  return {
    command: 'approval-plan',
    operation,
    stakesTier: 'amber',
    requiredGrant,
    requiredScopes: preview.requiredScopes,
    approvalText: approvalTextFor(operation, commandOpts),
    preview: {
      method: preview.httpRequest.method,
      url: preview.httpRequest.url,
      json: preview.httpRequest.json,
      bearerSecretName: preview.httpRequest.bearerSecretName,
    },
    approvedCommand,
  };
}

function approvalTextFor(operation, opts) {
  if (operation.startsWith('export-')) {
    return `Approve Miro Enterprise export operation ${operation} for org ${opts.orgId || '<org-id>'}.`;
  }
  return `Approve Miro board operation ${operation} on board ${opts.boardIds[0] || '<board-id>'}.`;
}

function explainError(opts) {
  const status = opts.status ? Number(opts.status) : undefined;
  const message = [opts.message || '', opts.bodyJson || ''].join(' ');
  const lowered = message.toLowerCase();
  const missingCredential = missingMiroCredentialFromMessage(message);
  if (missingCredential) {
    return {
      command: 'explain-error',
      classification: 'missing-credential',
      credential: missingCredential,
      retryable: false,
      operatorAction: missingCredentialAction(missingCredential),
    };
  }
  if (
    lowered.includes('miro_access_token') &&
    /\b(missing|not set|unavailable|unresolved)\b/.test(lowered)
  ) {
    return {
      command: 'explain-error',
      classification: 'missing-credential',
      credential: ACCESS_TOKEN_SECRET,
      retryable: false,
      operatorAction:
        `Set the runtime secret with hybridclaw secret set ${ACCESS_TOKEN_SECRET} "<oauth-or-access-token>" in the active HybridClaw runtime.`,
    };
  }
  if (
    lowered.includes('miro_discovery_access_token') &&
    /\b(missing|not set|unavailable|unresolved)\b/.test(lowered)
  ) {
    return {
      command: 'explain-error',
      classification: 'missing-credential',
      credential: DISCOVERY_TOKEN_SECRET,
      retryable: false,
      operatorAction:
        `Set the Enterprise Discovery runtime secret with hybridclaw secret set ${DISCOVERY_TOKEN_SECRET} "<token>".`,
    };
  }
  if (status === 401 || status === 403) {
    return {
      command: 'explain-error',
      classification: 'upstream-auth-or-scope',
      retryable: false,
      operatorAction:
        'Check the Miro token, board access, Enterprise role, and OAuth scopes for the attempted operation.',
    };
  }
  if (status === 429) {
    return {
      command: 'explain-error',
      classification: 'upstream-rate-limit',
      retryable: true,
      operatorAction:
        'Back off before retrying. Preserve cursor/request_id values for idempotent retries.',
    };
  }
  if (status >= 500) {
    return {
      command: 'explain-error',
      classification: 'upstream-service-error',
      retryable: true,
      operatorAction: 'Retry only after confirming the operation is idempotent.',
    };
  }
  return {
    command: 'explain-error',
    classification: 'unknown',
    retryable: false,
    operatorAction:
      'Inspect the gateway error body, network policy result, and Miro response before retrying.',
  };
}

function missingMiroCredentialFromMessage(message) {
  if (!/\b(missing|not set|unavailable|unresolved)\b/i.test(message)) {
    return '';
  }
  const known = [
    ACCESS_TOKEN_SECRET,
    DISCOVERY_TOKEN_SECRET,
    CLIENT_ID_SECRET,
    CLIENT_SECRET_SECRET,
    OAUTH_CODE_SECRET,
    REFRESH_TOKEN_SECRET,
  ];
  return known.find((name) => message.includes(name)) || '';
}

function missingCredentialAction(credential) {
  switch (credential) {
    case ACCESS_TOKEN_SECRET:
      return `Set the runtime secret with hybridclaw secret set ${ACCESS_TOKEN_SECRET} "<oauth-or-access-token>" in the active HybridClaw runtime.`;
    case DISCOVERY_TOKEN_SECRET:
      return `Set the Enterprise Discovery runtime secret with hybridclaw secret set ${DISCOVERY_TOKEN_SECRET} "<token>".`;
    case CLIENT_ID_SECRET:
      return `Store the Miro app client id with hybridclaw secret set ${CLIENT_ID_SECRET} "<client-id>".`;
    case CLIENT_SECRET_SECRET:
      return `Store the Miro app client secret with hybridclaw secret set ${CLIENT_SECRET_SECRET} "<client-secret>".`;
    case OAUTH_CODE_SECRET:
      return `Store the one-time Miro authorization code with hybridclaw secret set ${OAUTH_CODE_SECRET} "<code>", then exchange it immediately.`;
    case REFRESH_TOKEN_SECRET:
      return `Refresh requires a stored refresh token captured as ${REFRESH_TOKEN_SECRET}; rerun oauth-exchange-code if needed.`;
    default:
      return 'Set the missing Miro runtime secret in the active HybridClaw runtime.';
  }
}

function artifactDisplayPath(displayRoot, outputDir, filename) {
  return path.posix
    .join(displayRoot.replace(/\\/g, '/'), outputDir, filename)
    .replace(/\/+/g, '/');
}

function sanitizeFilenamePart(value) {
  return (
    String(value || 'miro-export')
      .trim()
      .replace(/[^a-zA-Z0-9._=-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 90) || 'miro-export'
  );
}

function extensionFromMimeType(mimeType, fallbackUrl) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('zip')) return '.zip';
  if (normalized.includes('pdf')) return '.pdf';
  if (normalized.includes('html')) return '.html';
  if (normalized.includes('svg')) return '.svg';
  try {
    const ext = path.extname(new URL(fallbackUrl).pathname).toLowerCase();
    if (['.zip', '.pdf', '.html', '.svg'].includes(ext)) return ext;
  } catch {
    return '.zip';
  }
  return '.zip';
}

function isPrivateHostname(hostname) {
  const lower = String(hostname || '').toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local')
  ) {
    return true;
  }
  const parsed = net.isIP(lower);
  if (parsed === 4) {
    const parts = lower.split('.').map((part) => Number.parseInt(part, 10));
    return (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168)
    );
  }
  if (parsed === 6) {
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd');
  }
  return false;
}

function assertExportUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) {
    throw new Error('--export-url is required.');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('--export-url must be a valid URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('--export-url must use HTTPS.');
  }
  if (isPrivateHostname(parsed.hostname)) {
    throw new Error('--export-url must not point to a private or local host.');
  }
  return value;
}

function resolveArtifactOutput(opts, mimeType, exportUrl) {
  const workspaceRoot =
    opts.workspaceRoot ||
    process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT ||
    process.cwd();
  const displayRoot =
    opts.displayRoot ||
    process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT ||
    workspaceRoot;
  const outputDir = opts.outputDir || DEFAULT_OUTPUT_DIR;
  if (path.isAbsolute(outputDir) || outputDir.split(/[\\/]/).includes('..')) {
    throw new Error('--output-dir must be a workspace-relative path.');
  }
  const filename =
    opts.filename ||
    `${sanitizeFilenamePart(opts.boardId || opts.jobId || 'miro-export')}-${Date.now()}${extensionFromMimeType(
      mimeType,
      exportUrl,
    )}`;
  if (!filename || path.basename(filename) !== filename) {
    throw new Error('--filename must be a basename.');
  }
  const hostDir = path.resolve(workspaceRoot, outputDir);
  const hostPath = path.resolve(hostDir, filename);
  const root = path.resolve(workspaceRoot);
  if (hostPath !== root && !hostPath.startsWith(root + path.sep)) {
    throw new Error('Resolved output path escapes the workspace.');
  }
  return {
    hostDir,
    hostPath,
    filename,
    displayPath: artifactDisplayPath(displayRoot, outputDir, filename),
  };
}

async function writeResponseBodyToFile(response, hostPath, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('Export download response did not include a readable body.');
  }
  const file = await fs.promises.open(hostPath, 'w');
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      if (bytes > maxBytes) {
        throw new Error(
          `Miro export download exceeds max size (${bytes} bytes > ${maxBytes}).`,
        );
      }
      await file.write(chunk);
    }
  } finally {
    await file.close();
    reader.releaseLock();
  }
  return bytes;
}

async function captureExportArtifact(commandOpts, options = {}) {
  const exportUrl = assertExportUrl(commandOpts.exportUrl);
  if (commandOpts.filename || commandOpts.outputDir) {
    resolveArtifactOutput(commandOpts, 'application/zip', exportUrl);
  }
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available for Miro export capture.');
  }
  const maxBytes =
    commandOpts.maxDownloadBytes === undefined
      ? DEFAULT_MAX_DOWNLOAD_BYTES
      : parseDownloadByteLimit(
          commandOpts.maxDownloadBytes,
          '--max-download-bytes',
          1,
          5_000_000_000,
        );
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs || 120_000,
  );
  let hostPath = '';
  try {
    const response = await fetchImpl(exportUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Miro export download failed with HTTP ${response.status}.`);
    }
    const contentLength = Number.parseInt(
      response.headers.get('content-length') || '',
      10,
    );
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(
        `Miro export download exceeds max size (${contentLength} bytes > ${maxBytes}).`,
      );
    }
    const mimeType =
      response.headers.get('content-type') || 'application/zip';
    const resolved = resolveArtifactOutput(
      {
        ...commandOpts,
        workspaceRoot: options.workspaceRoot,
        displayRoot: options.displayRoot,
      },
      mimeType,
      exportUrl,
    );
    hostPath = resolved.hostPath;
    fs.mkdirSync(resolved.hostDir, { recursive: true });
    const bytes = await writeResponseBodyToFile(response, hostPath, maxBytes);
    const artifact = {
      path: resolved.displayPath,
      filename: resolved.filename,
      mimeType,
      bytes,
    };
    return {
      command: 'capture-export',
      success: true,
      artifact,
      artifacts: [artifact],
    };
  } catch (error) {
    if (hostPath) {
      fs.rmSync(hostPath, { force: true });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseDownloadByteLimit(value, label, min, max) {
  const text = String(value || '').trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  const parsed = Number.parseInt(text, 10);
  if (parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function evalScenarios() {
  const read = buildHttpPayload(
    'list-items',
    { boardIds: ['board123'], type: 'sticky_note', limit: '10', scopes: [] },
    { timeoutMs: DEFAULT_TIMEOUT_MS, maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES },
  );
  const oauth = buildHttpPayload(
    'oauth-exchange-code',
    {
      boardIds: [],
      scopes: [],
      redirectUri: 'http://127.0.0.1:1455/oauth2/callback',
    },
    { timeoutMs: DEFAULT_TIMEOUT_MS, maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES },
  );
  const writePreview = buildHttpPayload(
    'create-sticky-note',
    {
      boardIds: ['board123'],
      scopes: [],
      content: 'Preview',
    },
    {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
      request: true,
    },
  );
  const checks = [
    {
      name: 'read-secret-ref',
      passed: read.httpRequest.bearerSecretName === ACCESS_TOKEN_SECRET,
    },
    {
      name: 'oauth-capture',
      passed:
        oauth.httpRequest.replaceSecretPlaceholders === true &&
        oauth.httpRequest.captureResponseFields?.some(
          (field) => field.secretName === ACCESS_TOKEN_SECRET,
        ),
    },
    {
      name: 'write-preview',
      passed:
        writePreview.dryRun === true &&
        writePreview.requiredGrant === BOARD_WRITE_GRANT,
    },
  ];
  return {
    command: 'eval-scenarios',
    scenarioCount: checks.length,
    failed: checks.filter((check) => !check.passed).length,
    checks,
  };
}

async function main() {
  try {
    const { opts: globalOpts, positional } = parseGlobalArgs(process.argv.slice(2));
    if (globalOpts.help || positional.length === 0) {
      process.stdout.write(`${usage()}\n`);
      return;
    }

    const command = positional[0];
    if (command === 'plan') {
      printJson(plan(positional.slice(1).join(' ')), globalOpts.format);
      return;
    }

    const { opts: commandOpts, positional: commandPositionals } =
      parseCommandOptions(positional.slice(1));
    if (command === 'http-request') {
      printJson(
        buildHttpPayload(commandPositionals[0], commandOpts, globalOpts),
        globalOpts.format,
      );
      return;
    }
    if (command === 'oauth') {
      const subcommand = commandPositionals[0];
      if (subcommand !== 'authorize-url') {
        fail('oauth supports only authorize-url.');
      }
      printJson(buildAuthorizeUrl(commandOpts), globalOpts.format);
      return;
    }
    if (command === 'approval-plan') {
      printJson(
        approvalPlan(
          commandPositionals[0],
          commandOpts,
          globalOpts,
          positional.slice(1),
        ),
        globalOpts.format,
      );
      return;
    }
    if (command === 'capture-export') {
      printJson(await captureExportArtifact(commandOpts), globalOpts.format);
      return;
    }
    if (command === 'explain-error') {
      printJson(explainError(commandOpts), globalOpts.format);
      return;
    }
    if (command === 'eval-scenarios') {
      printJson(evalScenarios(), globalOpts.format);
      return;
    }

    fail(`Unknown command: ${command}`);
  } catch (error) {
    fail(error.message || String(error));
  }
}

if (require.main === module) {
  main().catch((error) => {
    fail(error.message || String(error));
  });
}

module.exports = {
  buildHttpPayload,
  buildAuthorizeUrl,
  captureExportArtifact,
  explainError,
  plan,
};
