import { createHash } from 'node:crypto';

import type { McpClientManager } from './client-manager.js';
import type { McpServerConfig } from './types.js';

function cloneConfig(
  servers: Record<string, McpServerConfig> | undefined,
): Record<string, McpServerConfig> {
  return JSON.parse(JSON.stringify(servers || {})) as Record<
    string,
    McpServerConfig
  >;
}

function stableHash(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function configsEqual(
  left: McpServerConfig | undefined,
  right: McpServerConfig,
): boolean {
  return JSON.stringify(left || null) === JSON.stringify(right);
}

export class McpConfigWatcher {
  private lastConfig: Record<string, McpServerConfig> = {};
  private lastHash = stableHash('{}');

  constructor(private readonly manager: McpClientManager) {}

  async start(servers?: Record<string, McpServerConfig>): Promise<boolean> {
    return this.applyConfig(servers);
  }

  async applyConfig(
    servers?: Record<string, McpServerConfig>,
  ): Promise<boolean> {
    const nextConfig = cloneConfig(servers);
    const nextHash = stableHash(JSON.stringify(nextConfig));
    if (nextHash === this.lastHash) return false;

    const previous = this.lastConfig;
    const nextNames = new Set(Object.keys(nextConfig));

    for (const name of Object.keys(previous)) {
      if (nextNames.has(name)) continue;
      // Tearing down one server must not abort the whole apply.
      try {
        await this.manager.removeClient(name);
      } catch (error) {
        this.logServerFailure('disconnect', name, error);
      }
    }

    for (const [name, config] of Object.entries(nextConfig)) {
      if (configsEqual(previous[name], config)) continue;
      // A single MCP server failing to connect (e.g. an expired OAuth token
      // answering the initial POST with 401/invalid_token) must NOT reject
      // applyConfig — that rejection propagates up through syncMcpConfig into
      // the chat turn and crashes it, taking down ALL chat for the agent.
      // Log and skip the bad server so the turn proceeds with the rest.
      try {
        await this.manager.replaceClient(name, config);
      } catch (error) {
        this.logServerFailure('connect', name, error);
      }
    }

    this.lastConfig = nextConfig;
    this.lastHash = nextHash;
    return true;
  }

  stop(): void {
    this.lastConfig = {};
    this.lastHash = stableHash('{}');
  }

  private logServerFailure(
    phase: 'connect' | 'disconnect',
    name: string,
    error: unknown,
  ): void {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[mcp:${name}] failed to ${phase}: ${detail}`);
  }
}
