/**
 * MCP Streamable HTTP, server side, stateless and dual-era.
 *
 * Every POST is authenticated, then served on its own. A 2026-07-28 request
 * is validated strictly: required headers must match the body and `_meta`
 * must name the version, before any method runs. A legacy request (an
 * `initialize` handshake, or no 2026-07-28 `_meta`) is served the same tools
 * without a session: `initialize` only reports capabilities, so nothing
 * depends on it having happened. Replies are single JSON objects; this server
 * opens no SSE streams and keeps no per-connection state.
 * NOT the tool semantics (`tool-server.js`).
 */
import { timingSafeEqual } from 'node:crypto';
import {
  readWebhookJsonBody,
  sendWebhookJson,
  WebhookHttpError,
} from '@hybridaione/hybridclaw/plugin-sdk';

export const PROTOCOL_VERSION = '2026-07-28';
// Legacy eras (engineering choice, 2026-09-30): Microsoft Copilot Studio
// rejected the 2026-07-28-only endpoint with HTTP 400; these are the
// handshake-based Streamable HTTP revisions, newest first.
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const LEGACY_TOOL_METHODS = new Set(['tools/list', 'tools/call']);
export const SUPPORTED_VERSIONS = [PROTOCOL_VERSION, ...LEGACY_VERSIONS];
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
const NAMED_METHODS = new Set(['tools/call', 'resources/read', 'prompts/get']);
const MAX_BODY_BYTES = 256 * 1024;
const BASE64_SENTINEL = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/;
const HEADER_VALUE = /^[\x20-\x7e\t]*$/;

export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  HEADER_MISMATCH: -32020,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
};

export class RpcError extends Error {
  constructor(httpStatus, code, message, data) {
    super(message);
    this.httpStatus = httpStatus;
    this.code = code;
    this.data = data;
  }
}

function header(req, name) {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

function headerMismatch(message) {
  return new RpcError(400, RPC.HEADER_MISMATCH, `Header mismatch: ${message}`);
}

function decodeHeaderValue(name, raw) {
  if (!HEADER_VALUE.test(raw)) {
    throw headerMismatch(`${name} contains invalid characters`);
  }
  const encoded = raw.match(BASE64_SENTINEL);
  return encoded ? Buffer.from(encoded[1], 'base64').toString('utf8') : raw;
}

// `X-Api-Key` is for hosts that reserve Authorization for their own OAuth,
// such as Claude custom connectors; it carries the same token. `urlKey` is
// only passed when the operator opted in to the token in the URL.
function isTokenValid(req, token, urlKey) {
  const bearer = String(header(req, 'authorization') || '').match(
    /^Bearer\s+(\S+)$/i,
  )?.[1];
  const candidate = bearer ?? header(req, 'x-api-key')?.trim() ?? urlKey;
  if (!token || !candidate) return false;
  const provided = Buffer.from(candidate);
  const expected = Buffer.from(token);
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

function unsupportedVersion(requested) {
  return new RpcError(
    400,
    RPC.UNSUPPORTED_PROTOCOL_VERSION,
    `Unsupported protocol version. This server supports: ${SUPPORTED_VERSIONS.join(', ')}`,
    { supported: SUPPORTED_VERSIONS, requested: String(requested ?? '') },
  );
}

/**
 * A request is legacy when it opens the handshake, or carries no 2026-07-28
 * `_meta` and names a legacy version (or none) in its header.
 */
function isLegacyRequest(req, message) {
  if (message.method === 'initialize') return true;
  if (message.params?._meta?.[META_VERSION] !== undefined) return false;
  const headerVersion = header(req, 'mcp-protocol-version');
  return headerVersion === undefined || LEGACY_VERSIONS.includes(headerVersion);
}

async function callLegacyMethod(message, server) {
  if (message.method === 'initialize') {
    const requested = message.params?.protocolVersion;
    const discovered = await server.methods['server/discover']();
    return {
      protocolVersion: LEGACY_VERSIONS.includes(requested)
        ? requested
        : LEGACY_VERSIONS[0],
      capabilities: discovered.capabilities,
      serverInfo: server.serverInfo,
      ...(discovered.instructions
        ? { instructions: discovered.instructions }
        : {}),
    };
  }
  if (message.method === 'ping') return {};
  if (LEGACY_TOOL_METHODS.has(message.method)) {
    return server.methods[message.method](message.params ?? {});
  }
  throw new RpcError(200, RPC.METHOD_NOT_FOUND, 'Method not found.');
}

/** Checks everything 2026-07-28 requires before a method may run. */
function validateRequest(req, message) {
  const headerVersion = header(req, 'mcp-protocol-version');
  const headerMethod = header(req, 'mcp-method');
  if (!headerVersion) throw headerMismatch('MCP-Protocol-Version is missing');
  if (decodeHeaderValue('Mcp-Method', headerMethod ?? '') !== message.method) {
    throw headerMismatch('Mcp-Method does not match the request method');
  }
  if (NAMED_METHODS.has(message.method)) {
    const bodyName = message.params?.name ?? message.params?.uri;
    const headerName = header(req, 'mcp-name');
    if (!headerName || decodeHeaderValue('Mcp-Name', headerName) !== bodyName) {
      throw headerMismatch('Mcp-Name does not match the request name');
    }
  }
  const meta = message.params?._meta;
  const metaVersion = meta?.[META_VERSION];
  const capabilities = meta?.[META_CAPABILITIES];
  if (
    typeof metaVersion !== 'string' ||
    !capabilities ||
    typeof capabilities !== 'object' ||
    Array.isArray(capabilities)
  ) {
    throw new RpcError(
      400,
      RPC.INVALID_PARAMS,
      `Request _meta must include ${META_VERSION} and ${META_CAPABILITIES}.`,
    );
  }
  if (
    decodeHeaderValue('MCP-Protocol-Version', headerVersion) !== metaVersion
  ) {
    throw headerMismatch('MCP-Protocol-Version does not match _meta');
  }
  if (metaVersion !== PROTOCOL_VERSION) {
    throw unsupportedVersion(metaVersion);
  }
}

function sendRpc(res, status, id, payload) {
  sendWebhookJson(res, status, { jsonrpc: '2.0', id, ...payload });
}

async function readMessage(req) {
  try {
    return await readWebhookJsonBody(req, {
      maxBytes: MAX_BODY_BYTES,
      tooLargeMessage: 'Request body too large.',
      invalidJsonMessage: 'Parse error.',
    });
  } catch (error) {
    if (!(error instanceof WebhookHttpError)) throw error;
    const code =
      error.statusCode === 413 ? RPC.INVALID_REQUEST : RPC.PARSE_ERROR;
    throw new RpcError(error.statusCode, code, error.message);
  }
}

function readId(message) {
  const { id } = message;
  if (typeof id === 'string' || Number.isInteger(id)) return id;
  throw new RpcError(400, RPC.INVALID_REQUEST, 'Invalid request id.');
}

/**
 * Serves one MCP POST.
 *
 * @param {import('@hybridaione/hybridclaw/plugin-sdk').PluginInboundWebhookContext} ctx
 * @param {{
 *   token: string | undefined,
 *   allowUrlToken: boolean,
 *   allowedOrigins: Set<string>,
 *   serverInfo: { name: string, version: string },
 *   methods: Record<string, (params: Record<string, unknown>) => Promise<Record<string, unknown>>>,
 * }} server
 */
export async function handleMcpPost(ctx, server) {
  const { req, res } = ctx;
  let id = null;
  let legacy = false;
  try {
    const origin = header(req, 'origin');
    if (origin && !server.allowedOrigins.has(origin)) {
      throw new RpcError(403, RPC.INVALID_REQUEST, 'Origin not allowed.');
    }
    const urlKey = server.allowUrlToken
      ? (ctx.url.searchParams.get('key') ?? undefined)
      : undefined;
    if (!isTokenValid(req, server.token, urlKey)) {
      res.setHeader('www-authenticate', 'Bearer');
      throw new RpcError(401, RPC.INVALID_REQUEST, 'Unauthorized.');
    }
    const message = await readMessage(req);
    if (
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      message.jsonrpc !== '2.0' ||
      typeof message.method !== 'string'
    ) {
      throw new RpcError(400, RPC.INVALID_REQUEST, 'Invalid request.');
    }
    if (!('id' in message)) {
      res.statusCode = 202;
      res.end();
      return;
    }
    id = readId(message);
    legacy = isLegacyRequest(req, message);
    if (legacy) {
      sendRpc(res, 200, id, {
        result: await callLegacyMethod(message, server),
      });
      return;
    }
    validateRequest(req, message);
    const method = Object.hasOwn(server.methods, message.method)
      ? server.methods[message.method]
      : null;
    if (!method) {
      throw new RpcError(404, RPC.METHOD_NOT_FOUND, 'Method not found.');
    }
    const result = await method(message.params);
    sendRpc(res, 200, id, {
      result: {
        resultType: 'complete',
        ...result,
        _meta: { [META_SERVER_INFO]: server.serverInfo },
      },
    });
  } catch (error) {
    if (!(error instanceof RpcError)) {
      ctx.logger.error({ err: error }, 'Published tools request failed');
      sendRpc(res, 500, id, {
        error: { code: RPC.INTERNAL_ERROR, message: 'Internal error.' },
      });
      return;
    }
    // Legacy clients read a 404 as an expired session and may not parse the
    // body of other error statuses, so their JSON-RPC errors travel as 200.
    sendRpc(res, legacy ? 200 : error.httpStatus, id, {
      error: {
        code: error.code,
        message: error.message,
        ...(error.data ? { data: error.data } : {}),
      },
    });
  }
}
