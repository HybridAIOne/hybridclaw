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

/**
 * True when two configs differ only in a present `Authorization` header: the
 * gateway refreshing an OAuth token, which needs no new connection.
 */
function isAuthorizationRotation(
  previous: McpServerConfig | undefined,
  next: McpServerConfig,
): boolean {
  if (!previous?.headers?.Authorization || !next.headers?.Authorization) {
    return false;
  }
  return configsEqual(
    withoutAuthorization(previous),
    withoutAuthorization(next),
  );
}

function withoutAuthorization(config: McpServerConfig): McpServerConfig {
  const { Authorization: _authorization, ...headers } = config.headers || {};
  return { ...config, headers };
}

export class McpConfigWatcher {
  private lastConfig: Record<string, McpServerConfig> = {};
  private lastHash = stableHash('{}');
  private applying: Promise<unknown> = Promise.resolve();

  constructor(private readonly manager: McpClientManager) {}

  async start(servers?: Record<string, McpServerConfig>): Promise<boolean> {
    return this.applyConfig(servers);
  }

  /**
   * Applies run one at a time, so a warm worker's first request waits for the
   * connections its warm frame started instead of opening them a second time.
   */
  applyConfig(servers?: Record<string, McpServerConfig>): Promise<boolean> {
    const result = this.applying.then(() => this.applyNow(servers));
    this.applying = result.catch(() => undefined);
    return result;
  }

  private async applyNow(
    servers?: Record<string, McpServerConfig>,
  ): Promise<boolean> {
    const nextConfig = cloneConfig(servers);
    const nextHash = stableHash(JSON.stringify(nextConfig));
    if (nextHash === this.lastHash) return false;

    const previous = this.lastConfig;
    // Tearing down one server must not abort the whole apply.
    await Promise.all(
      Object.keys(previous)
        .filter((name) => !(name in nextConfig))
        .map((name) =>
          this.manager
            .removeClient(name)
            .catch((error) => this.logServerFailure('disconnect', name, error)),
        ),
    );

    // Servers connect in parallel. A single MCP server failing to connect
    // (e.g. an expired OAuth token answering the initial POST with
    // 401/invalid_token) must NOT reject applyConfig — that rejection
    // propagates up through syncMcpConfig into the chat turn and crashes it,
    // taking down ALL chat for the agent. Log and skip the bad server so the
    // turn proceeds with the rest.
    await Promise.all(
      Object.entries(nextConfig)
        .filter(([name, config]) => !configsEqual(previous[name], config))
        .map(([name, config]) =>
          (isAuthorizationRotation(previous[name], config)
            ? this.manager.rotateAuthorization(name, config)
            : this.manager.replaceClient(name, config)
          ).catch((error) => this.logServerFailure('connect', name, error)),
        ),
    );

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
