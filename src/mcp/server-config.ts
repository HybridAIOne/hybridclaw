/** Shared MCP server config rules used by the gateway, TUI, and config loader. */
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
