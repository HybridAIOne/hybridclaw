import type { McpServer } from '@agentclientprotocol/sdk';
import type { McpServerConfig } from '../types/models.js';

function headersToRecord(
  headers: Array<{ name: string; value: string }> | undefined,
): Record<string, string> | undefined {
  const mapped = Object.fromEntries(
    (headers || [])
      .map((header) => [String(header.name || '').trim(), header.value])
      .filter(([name]) => name.length > 0),
  );
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function envToRecord(
  env: Array<{ name: string; value: string }> | undefined,
): Record<string, string> | undefined {
  const mapped = Object.fromEntries(
    (env || [])
      .map((item) => [String(item.name || '').trim(), item.value])
      .filter(([name]) => name.length > 0),
  );
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

export function acpMcpServersToConfigMap(
  mcpServers: McpServer[] | null | undefined,
): Record<string, McpServerConfig> {
  const mapped: Record<string, McpServerConfig> = {};

  for (const server of mcpServers || []) {
    const name = String(server.name || '').trim();
    if (!name) continue;

    if ('type' in server && server.type === 'http') {
      mapped[name] = {
        transport: 'http',
        url: server.url,
        ...(headersToRecord(server.headers)
          ? { headers: headersToRecord(server.headers) }
          : {}),
      };
      continue;
    }

    if ('type' in server && server.type === 'sse') {
      mapped[name] = {
        transport: 'sse',
        url: server.url,
        ...(headersToRecord(server.headers)
          ? { headers: headersToRecord(server.headers) }
          : {}),
      };
      continue;
    }

    mapped[name] = {
      transport: 'stdio',
      command: server.command,
      args: [...server.args],
      ...(envToRecord(server.env) ? { env: envToRecord(server.env) } : {}),
    };
  }

  return mapped;
}
