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

function configsEqual(left: McpServerConfig | undefined, right: McpServerConfig): boolean {
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
      await this.manager.removeClient(name);
    }

    for (const [name, config] of Object.entries(nextConfig)) {
      if (!configsEqual(previous[name], config)) {
        await this.manager.replaceClient(name, config);
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
}
