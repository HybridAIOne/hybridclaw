import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { ToolKind } from './tool-classifier.js';

export interface McpServerConfig {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface McpToolDefinition {
  serverName: string;
  name: string;
  originalName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  kind: ToolKind;
}

export interface McpClientHandle {
  serverName: string;
  config: McpServerConfig;
  client: Client;
  transport: Transport;
  tools: McpToolDefinition[];
  healthy: boolean;
  lastError?: string;
}
