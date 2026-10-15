/**
 * Operator-owned MCP configuration, shared across the gateway/worker boundary.
 * Validates operator tool declarations at the config and IPC boundaries.
 * Only a configured approval broker can delegate marked writes to its own gate.
 */

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

/** The MCP server the runtime adds for the HybridAI platform's gateway tools. */
export const HYBRIDAI_MCP_SERVER_NAME: 'hybridai' = 'hybridai';

export function parseMcpToolBehaviorConfig(
  value: unknown,
): McpToolBehaviorConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MCP toolBehavior must be an object.');
  }
  const config = value as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) =>
        !['trustAnnotations', 'overrides', 'platformApprovals'].includes(key),
    )
  ) {
    throw new Error('Unknown MCP toolBehavior field.');
  }
  if (
    config.trustAnnotations !== undefined &&
    typeof config.trustAnnotations !== 'boolean'
  ) {
    throw new Error('MCP toolBehavior.trustAnnotations must be a boolean.');
  }
  if (
    config.platformApprovals !== undefined &&
    typeof config.platformApprovals !== 'boolean'
  )
    throw new Error('MCP toolBehavior.platformApprovals must be a boolean.');
  const overrides = config.overrides;
  if (
    overrides !== undefined &&
    (!overrides ||
      typeof overrides !== 'object' ||
      Array.isArray(overrides) ||
      Object.entries(overrides).some(
        ([name, behavior]) =>
          !name.trim() ||
          !['read-only', 'mutation'].includes(behavior as string),
      ))
  ) {
    throw new Error(
      'MCP toolBehavior.overrides must map exact tool names to read-only or mutation.',
    );
  }
  return {
    ...(config.platformApprovals !== undefined
      ? { platformApprovals: config.platformApprovals }
      : {}),
    ...(config.trustAnnotations !== undefined
      ? { trustAnnotations: config.trustAnnotations }
      : {}),
    ...(overrides !== undefined
      ? {
          overrides: { ...overrides } as Record<
            string,
            'read-only' | 'mutation'
          >,
        }
      : {}),
  };
}
