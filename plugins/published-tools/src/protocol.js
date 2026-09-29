/**
 * MCP 2026-07-28 Streamable HTTP, server side, stateless.
 *
 * Every POST is authenticated, then validated on its own: required headers
 * must match the body and `_meta` must name a supported version, before any
 * method runs. Legacy clients (`initialize`) get the version error the spec
 * asks modern-only servers to return. Replies are single JSON objects; this
 * server opens no SSE streams and keeps no per-connection state.
 * NOT the tool semantics (`tool-server.js`).
 */
import { timingSafeEqual } from 'node:crypto';

export const PROTOCOL_VERSION = '2026-07-28';
export const SUPPORTED_VERSIONS = [PROTOCOL_VERSION];
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

function isBearerTokenValid(req, token) {
  const match = String(header(req, 'authorization') || '').match(
    /^Bearer\s+(\S+)$/i,
  );
  if (!token || !match) return false;
  const provided = Buffer.from(match[1]);
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

/** Checks everything the spec requires before a method may run. */
function validateRequest(req, message) {
  if (message.method === 'initialize') {
    throw unsupportedVersion(message.params?.protocolVersion);
  }
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
  if (!SUPPORTED_VERSIONS.includes(metaVersion)) {
    throw unsupportedVersion(metaVersion);
  }
}

// The body helpers are local because an installed plugin cannot import
// hybridclaw/plugin-sdk at runtime; only its types are available.
function sendRpc(res, status, id, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ jsonrpc: '2.0', id, ...payload }));
}

async function readMessage(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new RpcError(413, RPC.INVALID_REQUEST, 'Request body too large.');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RpcError(400, RPC.PARSE_ERROR, 'Parse error.');
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
 * @param {import('hybridclaw/plugin-sdk').PluginInboundWebhookContext} ctx
 * @param {{
 *   token: string | undefined,
 *   allowedOrigins: Set<string>,
 *   serverInfo: { name: string, version: string },
 *   methods: Record<string, (params: Record<string, unknown>) => Promise<Record<string, unknown>>>,
 * }} server
 */
export async function handleMcpPost(ctx, server) {
  const { req, res } = ctx;
  let id = null;
  try {
    const origin = header(req, 'origin');
    if (origin && !server.allowedOrigins.has(origin)) {
      throw new RpcError(403, RPC.INVALID_REQUEST, 'Origin not allowed.');
    }
    if (!isBearerTokenValid(req, server.token)) {
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
    sendRpc(res, error.httpStatus, id, {
      error: {
        code: error.code,
        message: error.message,
        ...(error.data ? { data: error.data } : {}),
      },
    });
  }
}
