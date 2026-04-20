import type { McpServerConfig } from '../types/models.js';

function cloneStringArray(values?: string[]): string[] | undefined {
  return Array.isArray(values) ? [...values] : undefined;
}

function cloneStringRecord(
  values?: Record<string, string>,
): Record<string, string> | undefined {
  return values ? { ...values } : undefined;
}

export function cloneMcpServerConfig(config: McpServerConfig): McpServerConfig {
  return {
    transport: config.transport,
    ...(typeof config.command === 'string' ? { command: config.command } : {}),
    ...(Array.isArray(config.args)
      ? { args: cloneStringArray(config.args) }
      : {}),
    ...(config.env ? { env: cloneStringRecord(config.env) } : {}),
    ...(typeof config.cwd === 'string' ? { cwd: config.cwd } : {}),
    ...(typeof config.url === 'string' ? { url: config.url } : {}),
    ...(config.headers ? { headers: cloneStringRecord(config.headers) } : {}),
    ...(typeof config.enabled === 'boolean' ? { enabled: config.enabled } : {}),
  };
}

export function mergeSessionMcpServers(
  configuredServers: Record<string, McpServerConfig> | undefined,
  sessionOverride: Record<string, McpServerConfig> | undefined,
): Record<string, McpServerConfig> {
  const merged: Record<string, McpServerConfig> = {};

  for (const [name, config] of Object.entries(configuredServers || {})) {
    merged[name] = cloneMcpServerConfig(config);
  }

  for (const [name, config] of Object.entries(sessionOverride || {})) {
    merged[name] = cloneMcpServerConfig(config);
  }

  return merged;
}

function normalizeRecord(
  values?: Record<string, string>,
): Array<[string, string]> {
  return Object.entries(values || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, value]);
}

export function normalizeMcpServersForSignature(
  mcpServers?: Record<string, McpServerConfig>,
): Array<[string, Record<string, unknown>]> {
  return Object.entries(mcpServers || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, config]) => [
      name,
      {
        transport: config.transport,
        command: String(config.command || '').trim(),
        args: Array.isArray(config.args) ? [...config.args] : [],
        env: normalizeRecord(config.env),
        cwd: String(config.cwd || '').trim(),
        url: String(config.url || '').trim(),
        headers: normalizeRecord(config.headers),
        enabled:
          typeof config.enabled === 'boolean' ? config.enabled : undefined,
      },
    ]);
}
