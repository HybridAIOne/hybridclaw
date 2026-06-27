#!/usr/bin/env node
'use strict';

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:9090';
const DEFAULT_TIMEOUT_MS = 30_000;
const GATEWAY_TIMEOUT_BUFFER_MS = 5_000;
const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0/';
const DEFAULT_ACCESS_TOKEN_SECRET = 'MICROSOFT_365_ACCESS_TOKEN';
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;

function printHelp() {
  process.stdout.write(`Microsoft 365 skill helper

Usage:
  node skills/microsoft-365/m365.cjs [--format json|text] [--max-response-bytes n] <command> [options]

Commands:
  run <http-request command>             Send a helper-built request through the gateway
  http-request me                        Build a profile request
  http-request mail recent               Build a recent Outlook mail request
  http-request mail search --query q     Build an Outlook mail search request
  http-request calendar events           Build a calendarView request
  http-request drive recent              Build a recent OneDrive files request
  http-request drive search --query q    Build a OneDrive search request
  http-request teams joined              Build a joined Teams request
  http-request teams channels --team-id id
                                          Build a team channels request
  http-request teams messages --team-id id --channel-id id
                                          Build a channel messages request
  http-request chats list                Build a recent chats request

Common options:
  --top n                                Limit result count
  --start ISO                            Calendar range start
  --end ISO                              Calendar range end
  --timezone name                        Calendar response timezone, default UTC
`);
}

function parseMaxResponseBytes(raw) {
  if (raw === undefined || String(raw).trim() === '') {
    throw new Error('Missing value for --max-response-bytes.');
  }
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('--max-response-bytes must be a positive integer.');
  }
  return value;
}

function parseGlobalArgs(argv) {
  const parsed = {
    format: 'text',
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
    args: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg === '--format') {
      parsed.format = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg.startsWith('--format=')) {
      parsed.format = arg.slice('--format='.length);
      continue;
    }
    if (arg === '--max-response-bytes') {
      parsed.maxResponseBytes = parseMaxResponseBytes(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--max-response-bytes=')) {
      parsed.maxResponseBytes = parseMaxResponseBytes(
        arg.slice('--max-response-bytes='.length),
      );
      continue;
    }
    parsed.args.push(arg);
  }
  if (!['json', 'text'].includes(parsed.format)) {
    throw new Error('--format must be "json" or "text".');
  }
  return parsed;
}

function popFlag(args, name, defaultValue = '') {
  const index = args.findIndex(
    (arg) => arg === name || arg.startsWith(`${name}=`),
  );
  if (index === -1) return defaultValue;
  const arg = args.splice(index, 1)[0];
  if (arg.includes('=')) return arg.slice(name.length + 1);
  const value = args.splice(index, 1)[0];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for ${name}.`);
  }
  return value;
}

function rejectUnknownFlags(args) {
  const unknown = args.find((arg) => arg.startsWith('--'));
  if (unknown) throw new Error(`Unknown option: ${unknown}`);
}

function parseTop(raw, fallback = 10) {
  const value = raw ? Number.parseInt(String(raw), 10) : fallback;
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error('--top must be an integer between 1 and 50.');
  }
  return value;
}

function requireFlag(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`Missing required ${name}.`);
  return normalized;
}

function escapeODataString(value) {
  return String(value || '').replace(/'/g, "''");
}

function escapeGraphSearchPhrase(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function isoOrDefault(value, fallback) {
  const raw = String(value || '').trim() || fallback;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid ISO date/time: ${raw}`);
  }
  return new Date(timestamp).toISOString();
}

function defaultCalendarStart() {
  return new Date().toISOString();
}

function defaultCalendarEnd() {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

function graphUrl(pathname, query = {}) {
  const url = new URL(pathname.replace(/^\/+/u, ''), GRAPH_BASE_URL);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function buildHttpRequest(url, options = {}) {
  return {
    url,
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
    bearerSecretName: DEFAULT_ACCESS_TOKEN_SECRET,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES,
    skillName: 'microsoft-365',
  };
}

function buildMeRequest(maxResponseBytes) {
  return buildHttpRequest(
    graphUrl('me', {
      $select: 'id,displayName,userPrincipalName,mail,jobTitle,officeLocation',
    }),
    { maxResponseBytes },
  );
}

function buildMailRecentRequest(args, maxResponseBytes) {
  const top = parseTop(popFlag(args, '--top', '10'));
  rejectUnknownFlags(args);
  return buildHttpRequest(
    graphUrl('me/messages', {
      $top: top,
      $orderby: 'receivedDateTime desc',
      $select:
        'id,subject,from,receivedDateTime,webLink,isRead,bodyPreview,hasAttachments',
    }),
    { maxResponseBytes },
  );
}

function buildMailSearchRequest(args, maxResponseBytes) {
  const query = requireFlag(popFlag(args, '--query'), '--query');
  const top = parseTop(popFlag(args, '--top', '10'));
  rejectUnknownFlags(args);
  return buildHttpRequest(
    graphUrl('me/messages', {
      $top: top,
      $search: `"${escapeGraphSearchPhrase(query)}"`,
      $select:
        'id,subject,from,receivedDateTime,webLink,isRead,bodyPreview,hasAttachments',
    }),
    {
      headers: { ConsistencyLevel: 'eventual' },
      maxResponseBytes,
    },
  );
}

function buildCalendarEventsRequest(args, maxResponseBytes) {
  const start = isoOrDefault(popFlag(args, '--start'), defaultCalendarStart());
  const end = isoOrDefault(popFlag(args, '--end'), defaultCalendarEnd());
  const timezone = String(popFlag(args, '--timezone', 'UTC') || 'UTC').trim();
  const top = parseTop(popFlag(args, '--top', '25'), 25);
  rejectUnknownFlags(args);
  return buildHttpRequest(
    graphUrl('me/calendarView', {
      startDateTime: start,
      endDateTime: end,
      $top: top,
      $orderby: 'start/dateTime',
      $select:
        'id,subject,organizer,start,end,location,isOnlineMeeting,onlineMeeting,webLink',
    }),
    {
      headers: { Prefer: `outlook.timezone="${timezone}"` },
      maxResponseBytes,
    },
  );
}

function buildDriveRecentRequest(args, maxResponseBytes) {
  const top = parseTop(popFlag(args, '--top', '25'), 25);
  rejectUnknownFlags(args);
  return buildHttpRequest(
    graphUrl('me/drive/recent', {
      $top: top,
      $select:
        'id,name,webUrl,size,lastModifiedDateTime,createdDateTime,file,folder,remoteItem',
    }),
    { maxResponseBytes },
  );
}

function buildDriveSearchRequest(args, maxResponseBytes) {
  const query = requireFlag(popFlag(args, '--query'), '--query');
  const top = parseTop(popFlag(args, '--top', '25'), 25);
  rejectUnknownFlags(args);
  return buildHttpRequest(
    graphUrl(`me/drive/root/search(q='${escapeODataString(query)}')`, {
      $top: top,
      $select:
        'id,name,webUrl,size,lastModifiedDateTime,createdDateTime,file,folder,remoteItem',
    }),
    { maxResponseBytes },
  );
}

function buildTeamsJoinedRequest(args, maxResponseBytes) {
  const top = parseTop(popFlag(args, '--top', '25'), 25);
  rejectUnknownFlags(args);
  return buildHttpRequest(
    graphUrl('me/joinedTeams', {
      $top: top,
      $select: 'id,displayName,description',
    }),
    { maxResponseBytes },
  );
}

function buildTeamsChannelsRequest(args, maxResponseBytes) {
  const teamId = requireFlag(popFlag(args, '--team-id'), '--team-id');
  rejectUnknownFlags(args);
  return buildHttpRequest(
    graphUrl(`teams/${encodeURIComponent(teamId)}/channels`, {
      $select: 'id,displayName,description,membershipType',
    }),
    { maxResponseBytes },
  );
}

function buildTeamsMessagesRequest(args, maxResponseBytes) {
  const teamId = requireFlag(popFlag(args, '--team-id'), '--team-id');
  const channelId = requireFlag(popFlag(args, '--channel-id'), '--channel-id');
  const top = parseTop(popFlag(args, '--top', '10'));
  rejectUnknownFlags(args);
  return buildHttpRequest(
    graphUrl(
      `teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(
        channelId,
      )}/messages`,
      {
        $top: top,
      },
    ),
    { maxResponseBytes },
  );
}

function buildChatsListRequest(args, maxResponseBytes) {
  const top = parseTop(popFlag(args, '--top', '10'));
  rejectUnknownFlags(args);
  return buildHttpRequest(
    graphUrl('me/chats', {
      $top: top,
      $select: 'id,topic,chatType,createdDateTime,lastUpdatedDateTime',
    }),
    { maxResponseBytes },
  );
}

function buildHttpRequestCommand(args, maxResponseBytes) {
  const [area, action, ...rest] = args;
  if (area === 'me') {
    if (action) throw new Error('`me` does not accept an action.');
    return buildMeRequest(maxResponseBytes);
  }
  if (area === 'mail' && action === 'recent') {
    return buildMailRecentRequest(rest, maxResponseBytes);
  }
  if (area === 'mail' && action === 'search') {
    return buildMailSearchRequest(rest, maxResponseBytes);
  }
  if (area === 'calendar' && action === 'events') {
    return buildCalendarEventsRequest(rest, maxResponseBytes);
  }
  if (area === 'drive' && action === 'recent') {
    return buildDriveRecentRequest(rest, maxResponseBytes);
  }
  if (area === 'drive' && action === 'search') {
    return buildDriveSearchRequest(rest, maxResponseBytes);
  }
  if (area === 'teams' && action === 'joined') {
    return buildTeamsJoinedRequest(rest, maxResponseBytes);
  }
  if (area === 'teams' && action === 'channels') {
    return buildTeamsChannelsRequest(rest, maxResponseBytes);
  }
  if (area === 'teams' && action === 'messages') {
    return buildTeamsMessagesRequest(rest, maxResponseBytes);
  }
  if (area === 'chats' && action === 'list') {
    return buildChatsListRequest(rest, maxResponseBytes);
  }
  throw new Error('Unknown Microsoft 365 http-request command.');
}

function resolveGatewayUrl(raw) {
  const value =
    String(raw || '').trim() ||
    String(process.env.HYBRIDCLAW_GATEWAY_URL || '').trim() ||
    String(process.env.GATEWAY_BASE_URL || '').trim() ||
    DEFAULT_GATEWAY_URL;
  const normalized = value.replace(/\/+$/u, '');
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('--gateway-url must be an absolute http or https URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('--gateway-url must use http or https.');
  }
  return normalized;
}

function resolveGatewayToken(raw) {
  return (
    String(raw || '').trim() ||
    String(process.env.HYBRIDCLAW_GATEWAY_TOKEN || '').trim() ||
    String(process.env.GATEWAY_API_TOKEN || '').trim() ||
    String(process.env.WEB_API_TOKEN || '').trim()
  );
}

async function gatewayRequest(httpRequest, { gatewayUrl, gatewayToken }) {
  const url = `${gatewayUrl}/api/http/request`;
  const headers = { 'Content-Type': 'application/json' };
  if (gatewayToken) headers.Authorization = `Bearer ${gatewayToken}`;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    (httpRequest.timeoutMs || DEFAULT_TIMEOUT_MS) + GATEWAY_TIMEOUT_BUFFER_MS,
  );
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(httpRequest),
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(
      `Cannot reach HybridClaw gateway at ${url}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let envelope;
  try {
    envelope = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `Gateway returned non-JSON response: ${text.slice(0, 500)}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Gateway request failed with HTTP ${response.status}: ${text.slice(
        0,
        500,
      )}`,
    );
  }
  return envelope;
}

function output(payload, format) {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function main() {
  const global = parseGlobalArgs(process.argv.slice(2));
  if (global.help || global.args.length === 0) {
    printHelp();
    return;
  }

  const [command, ...args] = global.args;
  if (command === 'http-request') {
    const httpRequest = buildHttpRequestCommand(
      args,
      global.maxResponseBytes,
    );
    output(
      {
        command: 'http-request',
        httpRequest,
        auth: {
          bearerSecretName: DEFAULT_ACCESS_TOKEN_SECRET,
          provider: 'microsoft365',
        },
      },
      global.format,
    );
    return;
  }

  if (command === 'run') {
    const gatewayUrl = resolveGatewayUrl(popFlag(args, '--gateway-url'));
    const gatewayToken = resolveGatewayToken(popFlag(args, '--gateway-token'));
    const httpRequest = buildHttpRequestCommand(
      args,
      global.maxResponseBytes,
    );
    const response = await gatewayRequest(httpRequest, {
      gatewayUrl,
      gatewayToken,
    });
    output(
      {
        command: 'run',
        httpRequest,
        response,
      },
      global.format,
    );
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
