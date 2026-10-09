/**
 * Validates operator scheduling declarations at the config and IPC boundaries.
 * Server annotations cannot populate this config; approval is a separate policy.
 */
/** The MCP server the runtime adds for the HybridAI platform's gateway tools. */
export const HYBRIDAI_MCP_SERVER_NAME = 'hybridai';

export function parseMcpToolBehaviorConfig(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MCP toolBehavior must be an object.');
  }
  if (
    Object.keys(value).some(
      (key) => !['trustAnnotations', 'overrides'].includes(key),
    )
  ) {
    throw new Error('Unknown MCP toolBehavior field.');
  }
  if (
    value.trustAnnotations !== undefined &&
    typeof value.trustAnnotations !== 'boolean'
  ) {
    throw new Error('MCP toolBehavior.trustAnnotations must be a boolean.');
  }
  const overrides = value.overrides;
  if (
    overrides !== undefined &&
    (!overrides ||
      typeof overrides !== 'object' ||
      Array.isArray(overrides) ||
      Object.entries(overrides).some(
        ([name, behavior]) =>
          !name.trim() || !['read-only', 'mutation'].includes(behavior),
      ))
  ) {
    throw new Error(
      'MCP toolBehavior.overrides must map exact tool names to read-only or mutation.',
    );
  }
  return {
    ...(value.trustAnnotations !== undefined
      ? { trustAnnotations: value.trustAnnotations }
      : {}),
    ...(overrides !== undefined ? { overrides: { ...overrides } } : {}),
  };
}
