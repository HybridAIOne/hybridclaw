/** Operator-owned MCP configuration, shared across the gateway/worker boundary. */
export interface McpToolBehaviorConfig {
  trustAnnotations?: boolean;
  overrides?: Record<string, 'read-only' | 'mutation'>;
}

export interface McpServerConfig {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** The gateway handles OAuth and injects fresh Authorization headers. */
  auth?: 'oauth';
  enabled?: boolean;
  /** Scheduling declarations only; these never grant tool approval. */
  toolBehavior?: McpToolBehaviorConfig;
}

/** The MCP server the runtime adds for the HybridAI platform's gateway tools. */
export const HYBRIDAI_MCP_SERVER_NAME: 'hybridai';

export function parseMcpToolBehaviorConfig(
  value: unknown,
): McpToolBehaviorConfig | undefined;
