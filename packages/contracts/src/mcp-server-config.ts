/**
 * MCP server config as the gateway hands it to a worker: transport, launch
 * command or URL, and the operator's tool-behavior declarations.
 *
 * NOT the validator (`@hybridclaw/shared/mcp-server-config`); a declaration
 * here never mints a platform approval grant.
 */
/** Operator-owned MCP configuration, shared across the gateway/worker boundary. */
export interface McpToolBehaviorConfig {
  trustAnnotations?: boolean;
  /** Delegate marked writes to the platform's one-shot approval gate. */
  platformApprovals?: boolean;
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
  /** Operator declarations; these never mint a platform approval grant. */
  toolBehavior?: McpToolBehaviorConfig;
}
