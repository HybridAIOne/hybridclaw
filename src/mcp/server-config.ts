/**
 * MCP config validates operator input before the gateway forwards it to workers.
 * Scheduling declarations never come from server discovery or grant approval;
 * OAuth connection state belongs to mcp-oauth, not this parser.
 */
import { parseMcpToolBehaviorConfig } from '../../container/shared/mcp-server-config.js';
import type { McpServerConfig } from '../types/models.js';

export const MCP_SERVER_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function isValidMcpServerName(name: string): boolean {
  return MCP_SERVER_NAME_RE.test(name);
}

/** OAuth is only available for remote transports that carry HTTP headers. */
export function supportsMcpOAuth(
  transport: McpServerConfig['transport'],
): boolean {
  return transport === 'http' || transport === 'sse';
}

export function parseMcpServerConfig(rawJson: string): {
  config?: McpServerConfig;
  error?: string;
} {
  const trimmed = rawJson.trim();
  if (!trimmed) {
    return { error: 'Usage: `mcp add <name> <json>`' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'MCP server config must be a JSON object.' };
  }

  const record = parsed as Record<string, unknown>;
  const rawTransport = String(record.transport ?? record.type ?? '')
    .trim()
    .toLowerCase();
  const transport =
    rawTransport === 'streamable-http' || rawTransport === 'streamable_http'
      ? 'http'
      : rawTransport;

  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') {
    return {
      error: 'MCP server transport must be one of `stdio`, `http`, or `sse`.',
    };
  }
  if (
    transport === 'stdio' &&
    (typeof record.command !== 'string' || !record.command.trim())
  ) {
    return { error: 'stdio MCP servers require a non-empty `command`.' };
  }
  if (
    (transport === 'http' || transport === 'sse') &&
    (typeof record.url !== 'string' || !record.url.trim())
  ) {
    return {
      error: `${transport} MCP servers require a non-empty \`url\`.`,
    };
  }

  const rawAuth = String(record.auth ?? '')
    .trim()
    .toLowerCase();
  if (rawAuth && rawAuth !== 'none' && rawAuth !== 'oauth') {
    return { error: 'MCP server `auth` must be `oauth` when set.' };
  }
  if (rawAuth === 'oauth' && !supportsMcpOAuth(transport)) {
    return {
      error: 'OAuth is only supported for `http` and `sse` MCP servers.',
    };
  }

  const config = parsed as McpServerConfig;
  try {
    config.toolBehavior = parseMcpToolBehaviorConfig(record.toolBehavior);
  } catch (error) {
    return { error: (error as Error).message };
  }
  config.transport = transport;
  if (rawAuth === 'oauth') {
    config.auth = 'oauth';
  } else {
    delete config.auth;
  }
  return { config };
}
