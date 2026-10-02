import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

import type { ToolKind } from './tool-classifier.js';

export interface McpServerConfig {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** OAuth is handled by the gateway, which injects `headers.Authorization`. */
  auth?: 'oauth';
  enabled?: boolean;
}

export interface McpToolDefinition {
  serverName: string;
  name: string;
  originalName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  kind: ToolKind;
  annotations?: ToolAnnotations;
  /**
   * The server asks to keep this tool's schema out of the prompt until it is
   * needed (`_meta` `DEFER_LOADING_META`), e.g. HybridAI's catalog tools.
   */
  deferLoading?: boolean;
}

/**
 * MCP `_meta` key a server sets on a tool that is rarely needed: the runtime
 * then lists it by name behind `tool_catalog` instead of as a function.
 */
export const DEFER_LOADING_META = 'hybridai/deferLoading';

/** What the approval policy needs to know about an MCP tool. */
export type McpToolBehavior = Pick<McpToolDefinition, 'kind' | 'annotations'>;

/** HTTP/SSE request headers, read on every request. */
export interface LiveHeaders {
  current: Record<string, string>;
}

export interface McpClientHandle {
  serverName: string;
  config: McpServerConfig;
  client: Client;
  transport: Transport;
  /** Swapped in place when the gateway rotates the token; none for stdio. */
  headers?: LiveHeaders;
  tools: McpToolDefinition[];
  healthy: boolean;
  lastError?: string;
}
