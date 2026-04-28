import fs from 'node:fs';
import { buildMcpServerNamespaces } from '../../../container/shared/mcp-tool-namespaces.js';
import { listKnownToolNames } from '../../agent/tool-summary.js';
import {
  CONFIG_VERSION,
  ensureRuntimeConfigFile,
  getRuntimeConfig,
  getRuntimeDisabledToolNames,
  runtimeConfigPath,
  setRuntimeToolEnabled,
  updateRuntimeConfig,
} from '../../config/runtime-config.js';
import { getToolUsageSummary, type ToolUsageSummary } from '../../memory/db.js';
import type { DiagResult } from '../types.js';
import {
  buildChmodFix,
  buildUnusedWindowStart,
  DEFAULT_UNUSED_WINDOW_DAYS,
  formatDateOrNever,
  formatMode,
  isGroupOrWorldWritable,
  makeResult,
  readUnixMode,
  shortenHomePath,
  toErrorMessage,
} from '../utils.js';

type UnusedEntry = {
  name: string;
  lastUsedAt: string | null;
};

type UsageEntry = UnusedEntry & {
  toolNames: string[];
};

const DEPLOYMENT_CONFIG_VERSION = 22;

function formatUnusedEntries(entries: readonly UnusedEntry[]): string {
  return entries
    .map(
      (entry) =>
        `${entry.name} (last used ${formatDateOrNever(entry.lastUsedAt)})`,
    )
    .join(', ');
}

function findLatestToolLastUsedAt(
  toolNames: readonly string[],
  usageByTool: ReadonlyMap<string, ToolUsageSummary>,
): string | null {
  // Mirrors findServerLastUsedAt below, but works from an explicit tool list
  // instead of an MCP namespace prefix scan.
  let lastUsedAt: string | null = null;
  for (const toolName of toolNames) {
    const candidate = usageByTool.get(toolName)?.lastUsedAt ?? null;
    if (!lastUsedAt || (candidate && candidate > lastUsedAt)) {
      lastUsedAt = candidate;
    }
  }
  return lastUsedAt;
}

function buildUnusedToolEntries(
  enabledTools: readonly string[],
  usageByTool: ReadonlyMap<string, ToolUsageSummary>,
): UsageEntry[] {
  const isUnused = (name: string) =>
    (usageByTool.get(name)?.callsSinceCutoff ?? 0) === 0;
  const browserTools: string[] = [];
  let allBrowserToolsUnused = true;
  const unusedEntries: UsageEntry[] = [];

  for (const name of enabledTools) {
    if (name.startsWith('browser_')) {
      browserTools.push(name);
      allBrowserToolsUnused &&= isUnused(name);
      continue;
    }

    if (!isUnused(name)) continue;
    unusedEntries.push({
      name,
      toolNames: [name],
      lastUsedAt: usageByTool.get(name)?.lastUsedAt ?? null,
    });
  }

  if (browserTools.length > 0 && allBrowserToolsUnused) {
    unusedEntries.push({
      name: 'browser tools',
      toolNames: browserTools,
      lastUsedAt: findLatestToolLastUsedAt(browserTools, usageByTool),
    });
  }

  return unusedEntries.sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function buildUnusedToolsResult(usage: ToolUsageSummary[]): DiagResult | null {
  if (usage.length === 0) return null;

  const config = getRuntimeConfig();
  const disabled = getRuntimeDisabledToolNames(config);
  const enabledTools = listKnownToolNames().filter(
    (name) => !disabled.has(name),
  );
  const usageByTool = new Map(usage.map((entry) => [entry.toolName, entry]));
  const unused = buildUnusedToolEntries(enabledTools, usageByTool);

  if (unused.length === 0) return null;

  const previousDisabled = new Set(config.tools.disabled);
  const toolNames = unused.flatMap((entry) => entry.toolNames);
  const displayNames = unused.map((entry) => entry.name);
  return makeResult(
    'config',
    'Unused tools',
    'warn',
    `${unused.length} enabled ${unused.length === 1 ? 'tool or toolset' : 'tools or toolsets'} unused in the last ${DEFAULT_UNUSED_WINDOW_DAYS} days: ${formatUnusedEntries(unused)}. Re-enable individual tools with \`hybridclaw tool enable <name>\`.`,
    {
      summary: `Disable unused tools: ${displayNames.join(', ')}`,
      apply: async () => {
        updateRuntimeConfig((draft) => {
          for (const toolName of toolNames) {
            setRuntimeToolEnabled(draft, toolName, false);
          }
        });
      },
      rollback: async () => {
        updateRuntimeConfig((draft) => {
          for (const toolName of toolNames) {
            setRuntimeToolEnabled(
              draft,
              toolName,
              !previousDisabled.has(toolName),
            );
          }
        });
      },
    },
  );
}

function findServerLastUsedAt(
  namespace: string,
  usage: ToolUsageSummary[],
): string | null {
  let lastUsedAt: string | null = null;
  for (const entry of usage) {
    if (!entry.toolName.startsWith(`${namespace}__`)) continue;
    const candidate = entry.lastUsedAt ?? null;
    if (!lastUsedAt || (candidate && candidate > lastUsedAt)) {
      lastUsedAt = candidate;
    }
  }
  return lastUsedAt;
}

function buildUnusedMcpServersResult(
  usage: ToolUsageSummary[],
): DiagResult | null {
  if (usage.length === 0) return null;

  const config = getRuntimeConfig();
  const enabledServers = Object.entries(config.mcpServers || {}).filter(
    ([, serverConfig]) => serverConfig.enabled !== false,
  );
  if (enabledServers.length === 0) return null;

  const namespaces = buildMcpServerNamespaces(
    enabledServers.map(([name]) => name),
  );
  const unused = enabledServers
    .filter(([name]) => {
      const namespace = namespaces.get(name);
      if (!namespace) return false;
      return !usage.some(
        (entry) =>
          entry.toolName.startsWith(`${namespace}__`) &&
          entry.callsSinceCutoff > 0,
      );
    })
    .map(([name]) => ({
      name,
      lastUsedAt: findServerLastUsedAt(namespaces.get(name) || '', usage),
    }));

  if (unused.length === 0) return null;

  const previousEnabled = new Map(
    enabledServers.map(([name, serverConfig]) => [
      name,
      serverConfig.enabled !== false,
    ]),
  );
  const serverNames = unused.map((entry) => entry.name);
  return makeResult(
    'config',
    'Unused MCP servers',
    'warn',
    `${unused.length} enabled MCP server${unused.length === 1 ? '' : 's'} unused in the last ${DEFAULT_UNUSED_WINDOW_DAYS} days: ${formatUnusedEntries(unused)}. Re-enable with \`hybridclaw gateway mcp toggle <name>\`.`,
    {
      summary: `Disable unused MCP servers: ${serverNames.join(', ')}`,
      apply: async () => {
        updateRuntimeConfig((draft) => {
          for (const serverName of serverNames) {
            const entry = draft.mcpServers[serverName];
            if (entry) entry.enabled = false;
          }
        });
      },
      rollback: async () => {
        updateRuntimeConfig((draft) => {
          for (const serverName of serverNames) {
            const entry = draft.mcpServers[serverName];
            if (!entry) continue;
            entry.enabled = previousEnabled.get(serverName) !== false;
          }
        });
      },
    },
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function getRawDeployment(
  rawConfig: Record<string, unknown>,
): Record<string, unknown> | null {
  const rawDeployment = rawConfig.deployment;
  if (
    !rawDeployment ||
    typeof rawDeployment !== 'object' ||
    Array.isArray(rawDeployment)
  ) {
    return null;
  }
  return rawDeployment as Record<string, unknown>;
}

function getRawDeploymentField(
  rawConfig: Record<string, unknown>,
  key: string,
): unknown {
  const rawDeployment = getRawDeployment(rawConfig);
  if (!rawDeployment) return undefined;
  if (!Object.hasOwn(rawDeployment, key)) return undefined;
  return rawDeployment[key];
}

function getRawDeploymentTunnelProvider(
  rawConfig: Record<string, unknown>,
  fallback: string,
): string {
  const rawDeployment = getRawDeployment(rawConfig);
  const rawTunnel = rawDeployment?.tunnel;
  if (!rawTunnel || typeof rawTunnel !== 'object' || Array.isArray(rawTunnel)) {
    return fallback;
  }
  const rawProvider = (rawTunnel as Record<string, unknown>).provider;
  return typeof rawProvider === 'string' ? rawProvider.trim() : fallback;
}

function getDeploymentConfigIssues(rawConfig: Record<string, unknown>): {
  missingFields: string[];
  invalidFields: string[];
} {
  const missingFields: string[] = [];
  const invalidFields: string[] = [];
  const rawDeployment = getRawDeployment(rawConfig);
  const hasCurrentDeploymentSchema =
    rawDeployment !== null ||
    (typeof rawConfig.version === 'number' &&
      rawConfig.version >= DEPLOYMENT_CONFIG_VERSION);
  const rawMode = getRawDeploymentField(rawConfig, 'mode');
  const normalizedRawMode =
    typeof rawMode === 'string' ? rawMode.trim().toLowerCase() : '';
  const deploymentMode =
    normalizedRawMode === 'cloud' || normalizedRawMode === 'local'
      ? normalizedRawMode
      : 'local';
  const rawPublicUrl = getRawDeploymentField(rawConfig, 'public_url');
  const publicUrl = typeof rawPublicUrl === 'string' ? rawPublicUrl.trim() : '';
  const tunnelProvider = getRawDeploymentTunnelProvider(
    rawConfig,
    hasCurrentDeploymentSchema ? '' : 'manual',
  );

  if (
    rawMode !== undefined &&
    normalizedRawMode !== 'cloud' &&
    normalizedRawMode !== 'local'
  ) {
    invalidFields.push('deployment.mode must be "cloud" or "local"');
  }

  if (deploymentMode === 'cloud' && !publicUrl) {
    missingFields.push('deployment.public_url');
  }
  if (deploymentMode === 'local' && !tunnelProvider) {
    missingFields.push('deployment.tunnel.provider');
  }
  if (publicUrl && !isHttpUrl(publicUrl)) {
    invalidFields.push('deployment.public_url must be an HTTP(S) URL');
  }

  return { missingFields, invalidFields };
}

export async function checkConfigFile(): Promise<DiagResult[]> {
  const filePath = runtimeConfigPath();
  const displayPath = shortenHomePath(filePath);

  if (!fs.existsSync(filePath)) {
    return [
      makeResult('config', 'Config', 'error', `${displayPath} is missing`, {
        summary: `Create ${displayPath}`,
        apply: async () => {
          ensureRuntimeConfigFile();
        },
      }),
    ];
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  } catch (error) {
    return [
      makeResult(
        'config',
        'Config',
        'error',
        `${displayPath} is not valid JSON (${toErrorMessage(error)})`,
      ),
    ];
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [
      makeResult(
        'config',
        'Config',
        'error',
        `${displayPath} must contain a top-level object`,
      ),
    ];
  }

  const rawConfig = raw as Record<string, unknown>;
  const config = getRuntimeConfig();
  const mode = readUnixMode(filePath);
  const writableByOthers = isGroupOrWorldWritable(mode);
  const missingFields = [
    config.hybridai.defaultModel.trim() ? null : 'hybridai.defaultModel',
    config.ops.dbPath.trim() ? null : 'ops.dbPath',
    config.container.image.trim() ? null : 'container.image',
  ].filter(Boolean) as string[];
  const deploymentIssues = getDeploymentConfigIssues(rawConfig);
  missingFields.push(...deploymentIssues.missingFields);

  if (missingFields.length > 0 || deploymentIssues.invalidFields.length > 0) {
    const detail = [
      missingFields.length > 0
        ? `missing required field${missingFields.length === 1 ? '' : 's'}: ${missingFields.join(', ')}`
        : null,
      ...deploymentIssues.invalidFields,
    ]
      .filter(Boolean)
      .join('; ');
    return [
      makeResult('config', 'Config', 'error', `${displayPath} ${detail}`),
    ];
  }

  const version =
    typeof rawConfig.version === 'number' ? rawConfig.version : null;
  const severity = writableByOthers ? 'warn' : 'ok';
  const message =
    version === CONFIG_VERSION
      ? `${displayPath} valid (v${CONFIG_VERSION})${writableByOthers ? `, permissions ${formatMode(mode)}` : ''}`
      : `${displayPath} valid${version == null ? '' : ` (v${version})`}${writableByOthers ? `, permissions ${formatMode(mode)}` : ''}`;

  const results: DiagResult[] = [
    makeResult(
      'config',
      'Config',
      severity,
      message,
      writableByOthers
        ? buildChmodFix(filePath, 0o600, `Restrict ${displayPath} permissions`)
        : undefined,
    ),
  ];

  return results;
}

export async function checkConfig(): Promise<DiagResult[]> {
  const results = await checkConfigFile();
  if (results.some((result) => result.severity === 'error')) {
    return results;
  }

  const usage = getToolUsageSummary({
    sinceTimestamp: buildUnusedWindowStart(),
  });
  const unusedTools = buildUnusedToolsResult(usage);
  if (unusedTools) results.push(unusedTools);
  const unusedMcpServers = buildUnusedMcpServersResult(usage);
  if (unusedMcpServers) results.push(unusedMcpServers);

  return results;
}
