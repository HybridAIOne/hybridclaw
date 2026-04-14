import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendWebhookJson, WebhookHttpError } from '../channels/webhook-http.js';
import {
  getRuntimeConfig,
  type RuntimeConfig,
  runtimeConfigPath,
  saveRuntimeConfig,
} from '../config/runtime-config.js';
import { logger } from '../logger.js';
import {
  readPluginConfigEntry,
  readPluginConfigValue,
  setPluginEnabled,
  unsetPluginConfigValue,
  writePluginConfigValue,
} from '../plugins/plugin-config.js';
import { formatPluginSummaryList } from '../plugins/plugin-formatting.js';
import {
  checkPlugin,
  installPlugin,
  reinstallPlugin,
  uninstallPlugin,
} from '../plugins/plugin-install.js';
import {
  ensurePluginManagerInitialized,
  type PluginManager,
  reloadPluginManager,
  setPluginInboundMessageDispatcher,
  shutdownPluginManager,
} from '../plugins/plugin-manager.js';
import { isPluginInboundWebhookPath } from '../plugins/plugin-webhooks.js';
import { consumeCommandApproval } from './command-approval-trust.js';
import { handleGatewayMessage } from './gateway-chat-service.js';
import { tryEnsurePluginManagerInitializedForGateway } from './gateway-plugin-runtime.js';
import type {
  GatewayAdminPluginsResponse,
  GatewayCommandRequest,
  GatewayCommandResult,
} from './gateway-types.js';
import { rememberPendingApproval } from './pending-approvals.js';

let gatewayServiceInitialized = false;
let gatewayServiceInitializing: Promise<void> | null = null;

function badCommand(title: string, text: string): GatewayCommandResult {
  return { kind: 'error', title, text };
}

function infoCommand(title: string, text: string): GatewayCommandResult {
  return { kind: 'info', title, text };
}

function isLocalSession(req: GatewayCommandRequest): boolean {
  return (
    req.guildId === null &&
    (req.channelId === 'web' ||
      req.channelId === 'tui' ||
      req.channelId === 'cli')
  );
}

function formatPluginConfigValue(value: unknown): string {
  if (value === undefined) return '(not set)';
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatMissingBinaryRequirement(params: {
  name: string;
  command: string;
  configKey?: string;
}): string {
  if (params.configKey && params.command.trim() !== params.name.trim()) {
    return `${params.name} (from ${params.configKey}=${params.command})`;
  }
  return params.name;
}

function buildMissingBinaryGuidanceLines(
  pluginId: string,
  missingRequiredBins:
    | Array<{
        name: string;
        command: string;
        configKey?: string;
        installHint?: string;
        installUrl?: string;
      }>
    | undefined,
): string[] {
  if (!missingRequiredBins || missingRequiredBins.length === 0) return [];

  const lines = [
    `Missing required binaries right now: ${missingRequiredBins.map((entry) => formatMissingBinaryRequirement(entry)).join(', ')}.`,
  ];
  for (const entry of missingRequiredBins) {
    if (entry.installHint) {
      lines.push(`Install ${entry.name}: \`${entry.installHint}\``);
    }
    if (entry.installUrl) {
      lines.push(`Install docs for ${entry.name}: ${entry.installUrl}`);
    }
    if (entry.configKey) {
      lines.push(
        `If ${entry.name} is installed outside PATH, set it with: \`/plugin config ${pluginId} ${entry.configKey} /absolute/path/to/${entry.name}\``,
      );
    }
  }
  lines.push(
    'Until the missing binaries are installed, the plugin will remain unavailable.',
  );
  return lines;
}

interface PluginDependencyApprovalPlan {
  usesPackageJson: boolean;
  nodePackages: string[];
  pipPackages: string[];
}

interface PluginDependencyApprovalStep {
  approvalId: string;
  actionKey: string;
  prompt: string;
  allowSession: boolean;
  allowAgent: boolean;
  allowAll: boolean;
}

function buildPluginDependencyApprovalPrompt(params: {
  approvalId: string;
  intent: string;
  reason: string;
  consequenceIfDenied: string;
  allowSession: boolean;
  allowAgent: boolean;
  allowAll: boolean;
}): string {
  const optionLines = [
    'Reply `yes` to approve once.',
    params.allowSession
      ? 'Reply `yes for session` to trust this action for this session.'
      : 'Reply `yes for session` is unavailable for this approval.',
    params.allowAgent
      ? 'Reply `yes for agent` to trust it for this agent.'
      : 'Reply `yes for agent` is unavailable for this approval.',
    params.allowAll
      ? 'Reply `yes for all` to add this action to the workspace allowlist.'
      : 'Reply `yes for all` is unavailable for this approval.',
    'Reply `no` to deny.',
  ];
  return [
    `I need your approval before I ${params.intent}.`,
    `Why: ${params.reason}`,
    `If you skip this, ${params.consequenceIfDenied.charAt(0).toLowerCase()}${params.consequenceIfDenied.slice(1)}`,
    `Approval ID: ${params.approvalId}`,
    ...optionLines,
    'Approval expires in 120s.',
  ].join('\n');
}

function resolveNextPluginDependencyApprovalStep(params: {
  sessionId: string;
  source: string;
  plan: PluginDependencyApprovalPlan;
}): PluginDependencyApprovalStep | null {
  const steps: PluginDependencyApprovalStep[] = [];
  if (params.plan.usesPackageJson || params.plan.nodePackages.length > 0) {
    const approvalId = randomUUID();
    const commandPreview =
      params.plan.nodePackages.length > 0
        ? `run \`npm install --ignore-scripts --omit=dev --no-package-lock --no-audit --no-fund ${params.plan.nodePackages.join(' ')}\` for plugin \`${params.source}\``
        : `run \`npm install --ignore-scripts --omit=dev --no-audit --no-fund\` for plugin \`${params.source}\``;
    steps.push({
      approvalId,
      actionKey: 'plugin-deps:npm',
      prompt: buildPluginDependencyApprovalPrompt({
        approvalId,
        intent: commandPreview,
        reason: 'this changes the local Node.js dependency state',
        consequenceIfDenied: 'dependency installation will be skipped.',
        allowSession: true,
        allowAgent: false,
        allowAll: false,
      }),
      allowSession: true,
      allowAgent: false,
      allowAll: false,
    });
  }
  if (params.plan.pipPackages.length > 0) {
    const approvalId = randomUUID();
    steps.push({
      approvalId,
      actionKey: 'plugin-deps:pip',
      prompt: buildPluginDependencyApprovalPrompt({
        approvalId,
        intent: `install Python packages for plugin \`${params.source}\`: ${params.plan.pipPackages.join(', ')}`,
        reason: 'this changes the local Python dependency state',
        consequenceIfDenied: 'dependency installation will be skipped.',
        allowSession: true,
        allowAgent: false,
        allowAll: false,
      }),
      allowSession: true,
      allowAgent: false,
      allowAll: false,
    });
  }

  for (const step of steps) {
    if (
      !consumeCommandApproval({
        sessionId: params.sessionId,
        actionKey: step.actionKey,
      })
    ) {
      return step;
    }
  }
  return null;
}

function buildDependencyInstallLines(params: {
  dependencySummary: {
    usedPackageJson: boolean;
    installedNodePackages: string[];
    installedPipPackages: string[];
  };
  configuredRequiredBins: Array<{
    name: string;
    command: string;
    configKey: string;
  }>;
  externalDependencies: Array<{
    name: string;
    installed: boolean;
    installHint?: string;
    installUrl?: string;
  }>;
}): string[] {
  const lines: string[] = [];
  if (params.dependencySummary.usedPackageJson) {
    lines.push('Installed plugin Node.js dependencies from package.json.');
  }
  if (params.dependencySummary.installedNodePackages.length > 0) {
    lines.push(
      `Installed plugin npm packages: ${params.dependencySummary.installedNodePackages.join(', ')}.`,
    );
  }
  if (params.dependencySummary.installedPipPackages.length > 0) {
    lines.push(
      `Installed plugin pip packages: ${params.dependencySummary.installedPipPackages.join(', ')}.`,
    );
  }
  for (const entry of params.configuredRequiredBins) {
    lines.push(
      `Configured ${entry.name} via \`${entry.configKey} = ${entry.command}\`.`,
    );
  }
  for (const entry of params.externalDependencies.filter(
    (dependency) => !dependency.installed,
  )) {
    lines.push(`External dependency check failed for ${entry.name}.`);
    if (entry.installHint) {
      lines.push(`Install ${entry.name}: \`${entry.installHint}\``);
    }
    if (entry.installUrl) {
      lines.push(`Install docs for ${entry.name}: ${entry.installUrl}`);
    }
  }
  return lines;
}

function buildPluginCheckLines(result: {
  pluginId: string;
  pluginDir: string;
  source: string;
  requiresEnv: string[];
  missingEnv: string[];
  requiredConfigKeys: string[];
  packageJsonDependencies: Array<{ package: string; installed: boolean }>;
  nodeDependencies: Array<{ package: string; installed: boolean }>;
  pipDependencies: Array<{ package: string; installed: boolean }>;
  externalDependencies: Array<{
    name: string;
    installed: boolean;
    check: string;
    installHint?: string;
    installUrl?: string;
  }>;
  configuredRequiredBins: Array<{
    name: string;
    command: string;
    configKey: string;
  }>;
  missingRequiredBins?: Array<{
    name: string;
    command: string;
    configKey?: string;
    installHint?: string;
    installUrl?: string;
  }>;
}): string[] {
  const lines = [
    `Plugin: ${result.pluginId}`,
    `Directory: \`${result.pluginDir}\``,
    `Source: ${result.source}`,
  ];
  if (result.requiresEnv.length > 0) {
    lines.push(`Required env vars: ${result.requiresEnv.join(', ')}`);
  }
  if (result.missingEnv.length > 0) {
    lines.push(`Missing env vars: ${result.missingEnv.join(', ')}`);
  }
  if (result.packageJsonDependencies.length > 0) {
    lines.push(
      `package.json dependencies: ${result.packageJsonDependencies.map((entry) => `${entry.package}=${entry.installed ? 'ok' : 'missing'}`).join(', ')}`,
    );
  }
  if (result.nodeDependencies.length > 0) {
    lines.push(
      `Manifest npm dependencies: ${result.nodeDependencies.map((entry) => `${entry.package}=${entry.installed ? 'ok' : 'missing'}`).join(', ')}`,
    );
  }
  if (result.pipDependencies.length > 0) {
    lines.push(
      `Manifest pip dependencies: ${result.pipDependencies.map((entry) => `${entry.package}=${entry.installed ? 'ok' : 'missing'}`).join(', ')}`,
    );
  }
  if (result.externalDependencies.length > 0) {
    lines.push(
      `External dependencies: ${result.externalDependencies.map((entry) => `${entry.name}=${entry.installed ? 'ok' : 'missing'}`).join(', ')}`,
    );
  }
  if (result.configuredRequiredBins.length > 0) {
    lines.push(
      `Configured binary paths: ${result.configuredRequiredBins.map((entry) => `${entry.name} (${entry.configKey}=${entry.command})`).join(', ')}`,
    );
  }
  lines.push(
    ...buildMissingBinaryGuidanceLines(
      result.pluginId,
      result.missingRequiredBins,
    ),
  );
  if (result.requiredConfigKeys.length > 0) {
    lines.push(`Required config keys: ${result.requiredConfigKeys.join(', ')}`);
  }
  return lines;
}

function isDependencyApprovalRequiredError(error: unknown): error is {
  plan: {
    usesPackageJson: boolean;
    nodePackages: string[];
    pipPackages: string[];
  };
} {
  if (!(error instanceof Error)) return false;
  const plan = (error as { plan?: unknown }).plan;
  if (!plan || typeof plan !== 'object') return false;
  const candidate = plan as {
    usesPackageJson?: unknown;
    nodePackages?: unknown;
    pipPackages?: unknown;
  };
  return (
    typeof candidate.usesPackageJson === 'boolean' &&
    Array.isArray(candidate.nodePackages) &&
    Array.isArray(candidate.pipPackages)
  );
}

export async function reloadPluginRuntime(): Promise<{
  ok: boolean;
  message: string;
}> {
  try {
    await reloadPluginManager();
    return {
      ok: true,
      message: 'Plugin runtime reloaded.',
    };
  } catch (error) {
    return {
      ok: false,
      message: `Plugin runtime reload failed: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
}

async function rollbackPluginRuntimeConfigChange(
  previousConfig: RuntimeConfig,
  context: {
    action: string;
    pluginId: string;
    key?: string;
    reloadMessage: string;
  },
): Promise<string[]> {
  saveRuntimeConfig(previousConfig);
  const rollbackReloadResult = await reloadPluginRuntime();
  if (rollbackReloadResult.ok) {
    return ['Previous runtime config was restored.'];
  }

  logger.warn(
    {
      action: context.action,
      pluginId: context.pluginId,
      key: context.key,
      reloadMessage: context.reloadMessage,
      rollbackReloadMessage: rollbackReloadResult.message,
    },
    'Plugin runtime rollback reload failed',
  );
  return [
    'Previous runtime config was restored.',
    'Plugin runtime reload also failed after rollback; plugin state may be inconsistent until the next successful reload.',
    rollbackReloadResult.message,
  ];
}

export async function initGatewayService(): Promise<void> {
  if (gatewayServiceInitialized) return;
  if (gatewayServiceInitializing) {
    await gatewayServiceInitializing;
    return;
  }
  gatewayServiceInitializing = (async () => {
    setPluginInboundMessageDispatcher(
      async (pluginId, request) =>
        await handleGatewayMessage({
          ...request,
          source: `plugin:${pluginId}`,
        }),
    );
    try {
      await ensurePluginManagerInitialized();
    } catch (error) {
      logger.warn({ error }, 'Plugin manager initialization failed');
    }
    gatewayServiceInitialized = true;
  })();
  try {
    await gatewayServiceInitializing;
  } finally {
    gatewayServiceInitializing = null;
  }
}

export async function stopGatewayPlugins(): Promise<void> {
  await shutdownPluginManager();
}

export async function handlePluginGatewayCommand(params: {
  req: GatewayCommandRequest;
  pluginManager: PluginManager | null;
  pluginInitError: unknown;
}): Promise<GatewayCommandResult> {
  const { req, pluginManager, pluginInitError } = params;
  const sub = (req.args[1] || 'list').toLowerCase();

  if (sub === 'list') {
    if (!pluginManager) {
      return badCommand(
        'Plugin Runtime Unavailable',
        pluginInitError instanceof Error
          ? pluginInitError.message
          : 'Plugin manager failed to initialize.',
      );
    }
    return infoCommand(
      'Plugins',
      formatPluginSummaryList(pluginManager.listPluginSummary()),
    );
  }

  if (sub === 'config') {
    const pluginId = String(req.args[2] || '').trim();
    const key = String(req.args[3] || '').trim();
    const rawValue = req.args.slice(4).join(' ').trim();
    if (!pluginId) {
      return badCommand(
        'Usage',
        'Usage: `plugin config <plugin-id> [key] [value|--unset]`',
      );
    }
    if (!key) {
      const result = readPluginConfigEntry(pluginId);
      if (!result.entry) {
        return infoCommand(
          'Plugin Config',
          [
            `Plugin: ${result.pluginId}`,
            `Config file: ${result.configPath}`,
            'Override: (none)',
          ].join('\n'),
        );
      }
      return infoCommand(
        'Plugin Config',
        [
          `Plugin: ${result.pluginId}`,
          `Config file: ${result.configPath}`,
          'Override:',
          formatPluginConfigValue(result.entry),
        ].join('\n'),
      );
    }
    if (!rawValue) {
      const result = readPluginConfigValue(pluginId, key);
      return infoCommand(
        'Plugin Config',
        [
          `Plugin: ${result.pluginId}`,
          `Key: ${result.key}`,
          `Value: ${formatPluginConfigValue(result.value)}`,
          `Config file: ${result.configPath}`,
        ].join('\n'),
      );
    }
    if (!isLocalSession(req)) {
      return badCommand(
        'Plugin Config Restricted',
        '`plugin config` writes runtime config and is only available from local TUI/web sessions.',
      );
    }

    const previousConfig = getRuntimeConfig();
    try {
      const result =
        rawValue === '--unset'
          ? await unsetPluginConfigValue(pluginId, key)
          : await writePluginConfigValue(pluginId, key, rawValue);
      const reloadResult = await reloadPluginRuntime();
      if (!reloadResult.ok) {
        const rollbackLines = await rollbackPluginRuntimeConfigChange(
          previousConfig,
          {
            action: 'plugin config',
            pluginId: result.pluginId,
            key: result.key,
            reloadMessage: reloadResult.message,
          },
        );
        return badCommand(
          'Plugin Config Failed',
          [
            `Plugin: ${result.pluginId}`,
            `Key: ${result.key}`,
            `Updated runtime config at \`${result.configPath}\`, but plugin reload failed.`,
            ...rollbackLines,
          ].join('\n'),
        );
      }
      return infoCommand(
        result.removed
          ? result.changed
            ? 'Plugin Config Removed'
            : 'Plugin Config Unchanged'
          : result.changed
            ? 'Plugin Config Updated'
            : 'Plugin Config Unchanged',
        [
          `Plugin: ${result.pluginId}`,
          `Key: ${result.key}`,
          result.removed
            ? result.changed
              ? 'Value: (unset)'
              : 'Value was already unset.'
            : `Value: ${formatPluginConfigValue(result.value)}`,
          `Updated runtime config at \`${result.configPath}\`.`,
          reloadResult.message,
        ].join('\n'),
      );
    } catch (error) {
      saveRuntimeConfig(previousConfig);
      return badCommand(
        'Plugin Config Failed',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (sub === 'enable' || sub === 'disable') {
    const pluginId = String(req.args[2] || '').trim();
    if (!pluginId) {
      return badCommand('Usage', `Usage: \`plugin ${sub} <plugin-id>\``);
    }
    if (!isLocalSession(req)) {
      return badCommand(
        `Plugin ${sub === 'enable' ? 'Enable' : 'Disable'} Restricted`,
        `\`plugin ${sub}\` writes runtime config and is only available from local TUI/web sessions.`,
      );
    }

    const enabled = sub === 'enable';
    const previousConfig = getRuntimeConfig();
    try {
      const result = await setPluginEnabled(pluginId, enabled);
      const reloadResult = await reloadPluginRuntime();
      if (!reloadResult.ok) {
        const rollbackLines = await rollbackPluginRuntimeConfigChange(
          previousConfig,
          {
            action: `plugin ${sub}`,
            pluginId: result.pluginId,
            reloadMessage: reloadResult.message,
          },
        );
        return badCommand(
          `Plugin ${enabled ? 'Enable' : 'Disable'} Failed`,
          [
            `Plugin: ${result.pluginId}`,
            `Updated runtime config at \`${result.configPath}\`, but plugin reload failed.`,
            ...rollbackLines,
          ].join('\n'),
        );
      }
      return infoCommand(
        result.changed
          ? `Plugin ${enabled ? 'Enabled' : 'Disabled'}`
          : 'Plugin Unchanged',
        [
          `Plugin: ${result.pluginId}`,
          `Status: ${enabled ? 'enabled' : 'disabled'}`,
          result.changed
            ? `Updated runtime config at \`${result.configPath}\`.`
            : 'Status was already set.',
          reloadResult.message,
        ].join('\n'),
      );
    } catch (error) {
      saveRuntimeConfig(previousConfig);
      return badCommand(
        `Plugin ${enabled ? 'Enable' : 'Disable'} Failed`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (sub === 'install') {
    const source = String(req.args[2] || '').trim();
    const yes = String(req.args[3] || '').trim();
    if (!source) {
      return badCommand(
        'Usage',
        'Usage: `plugin install <path|plugin-id|npm-spec> [--yes]`',
      );
    }
    if (yes && yes !== '--yes') {
      return badCommand(
        'Usage',
        'Usage: `plugin install <path|plugin-id|npm-spec> [--yes]`',
      );
    }
    if (!isLocalSession(req)) {
      return badCommand(
        'Plugin Install Restricted',
        '`plugin install` is only available from local TUI/web sessions.',
      );
    }
    try {
      const result = await installPlugin(source, {
        approveDependencyInstall: yes === '--yes',
      });
      const reloadResult = await reloadPluginRuntime();
      const lines = [
        result.alreadyInstalled
          ? `Plugin \`${result.pluginId}\` is already present at \`${result.pluginDir}\`.`
          : `Installed plugin \`${result.pluginId}\` to \`${result.pluginDir}\`.`,
        ...buildDependencyInstallLines(result),
        `Plugin \`${result.pluginId}\` will auto-discover from \`${result.pluginDir}\`.`,
        ...buildMissingBinaryGuidanceLines(
          result.pluginId,
          result.missingRequiredBins,
        ),
        ...(result.requiresEnv.length > 0
          ? [`Required env vars: ${result.requiresEnv.join(', ')}`]
          : []),
        result.requiredConfigKeys.length > 0
          ? `Add a \`plugins.list[]\` override in \`${runtimeConfigPath()}\` to set required config keys: ${result.requiredConfigKeys.join(', ')}`
          : `No config entry is required unless you want plugin overrides in \`${runtimeConfigPath()}\`.`,
        reloadResult.message,
      ];
      return infoCommand('Plugin Installed', lines.join('\n'));
    } catch (error) {
      if (isDependencyApprovalRequiredError(error)) {
        const step = resolveNextPluginDependencyApprovalStep({
          sessionId: req.sessionId,
          source,
          plan: error.plan,
        });
        if (!step) {
          const result = await installPlugin(source, {
            approveDependencyInstall: true,
          });
          const reloadResult = await reloadPluginRuntime();
          const lines = [
            result.alreadyInstalled
              ? `Plugin \`${result.pluginId}\` is already present at \`${result.pluginDir}\`.`
              : `Installed plugin \`${result.pluginId}\` to \`${result.pluginDir}\`.`,
            ...buildDependencyInstallLines(result),
            `Plugin \`${result.pluginId}\` will auto-discover from \`${result.pluginDir}\`.`,
            ...buildMissingBinaryGuidanceLines(
              result.pluginId,
              result.missingRequiredBins,
            ),
            ...(result.requiresEnv.length > 0
              ? [`Required env vars: ${result.requiresEnv.join(', ')}`]
              : []),
            result.requiredConfigKeys.length > 0
              ? `Add a \`plugins.list[]\` override in \`${runtimeConfigPath()}\` to set required config keys: ${result.requiredConfigKeys.join(', ')}`
              : `No config entry is required unless you want plugin overrides in \`${runtimeConfigPath()}\`.`,
            reloadResult.message,
          ];
          return infoCommand('Plugin Installed', lines.join('\n'));
        }
        await rememberPendingApproval({
          sessionId: req.sessionId,
          approvalId: step.approvalId,
          prompt: step.prompt,
          userId: String(req.userId || req.sessionId).trim() || req.sessionId,
          commandAction: {
            approveArgs: ['plugin', 'install', source],
            actionKey: step.actionKey,
            allowSession: step.allowSession,
            allowAgent: step.allowAgent,
            allowAll: step.allowAll,
            denyTitle: 'Plugin Install Cancelled',
            denyText: `Cancelled plugin install for \`${source}\`.`,
          },
        });
        return infoCommand('Pending Approval', step.prompt);
      }
      return badCommand(
        'Plugin Install Failed',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (sub === 'reinstall') {
    const source = String(req.args[2] || '').trim();
    const yes = String(req.args[3] || '').trim();
    if (!source) {
      return badCommand(
        'Usage',
        'Usage: `plugin reinstall <path|plugin-id|npm-spec> [--yes]`',
      );
    }
    if (yes && yes !== '--yes') {
      return badCommand(
        'Usage',
        'Usage: `plugin reinstall <path|plugin-id|npm-spec> [--yes]`',
      );
    }
    if (!isLocalSession(req)) {
      return badCommand(
        'Plugin Reinstall Restricted',
        '`plugin reinstall` is only available from local TUI/web sessions.',
      );
    }
    try {
      const result = await reinstallPlugin(source, {
        approveDependencyInstall: yes === '--yes',
      });
      const reloadResult = await reloadPluginRuntime();
      const lines = [
        result.replacedExistingInstall
          ? `Reinstalled plugin \`${result.pluginId}\` to \`${result.pluginDir}\`.`
          : `Installed plugin \`${result.pluginId}\` to \`${result.pluginDir}\`.`,
        ...buildDependencyInstallLines(result),
        `Plugin \`${result.pluginId}\` will auto-discover from \`${result.pluginDir}\`.`,
        ...buildMissingBinaryGuidanceLines(
          result.pluginId,
          result.missingRequiredBins,
        ),
        ...(result.requiresEnv.length > 0
          ? [`Required env vars: ${result.requiresEnv.join(', ')}`]
          : []),
        result.requiredConfigKeys.length > 0
          ? `Add a \`plugins.list[]\` override in \`${runtimeConfigPath()}\` to set required config keys: ${result.requiredConfigKeys.join(', ')}`
          : `No config entry is required unless you want plugin overrides in \`${runtimeConfigPath()}\`.`,
        reloadResult.message,
      ];
      return infoCommand('Plugin Reinstalled', lines.join('\n'));
    } catch (error) {
      if (isDependencyApprovalRequiredError(error)) {
        const step = resolveNextPluginDependencyApprovalStep({
          sessionId: req.sessionId,
          source,
          plan: error.plan,
        });
        if (!step) {
          const result = await reinstallPlugin(source, {
            approveDependencyInstall: true,
          });
          const reloadResult = await reloadPluginRuntime();
          const lines = [
            result.replacedExistingInstall
              ? `Reinstalled plugin \`${result.pluginId}\` to \`${result.pluginDir}\`.`
              : `Installed plugin \`${result.pluginId}\` to \`${result.pluginDir}\`.`,
            ...buildDependencyInstallLines(result),
            `Plugin \`${result.pluginId}\` will auto-discover from \`${result.pluginDir}\`.`,
            ...buildMissingBinaryGuidanceLines(
              result.pluginId,
              result.missingRequiredBins,
            ),
            ...(result.requiresEnv.length > 0
              ? [`Required env vars: ${result.requiresEnv.join(', ')}`]
              : []),
            result.requiredConfigKeys.length > 0
              ? `Add a \`plugins.list[]\` override in \`${runtimeConfigPath()}\` to set required config keys: ${result.requiredConfigKeys.join(', ')}`
              : `No config entry is required unless you want plugin overrides in \`${runtimeConfigPath()}\`.`,
            reloadResult.message,
          ];
          return infoCommand('Plugin Reinstalled', lines.join('\n'));
        }
        await rememberPendingApproval({
          sessionId: req.sessionId,
          approvalId: step.approvalId,
          prompt: step.prompt,
          userId: String(req.userId || req.sessionId).trim() || req.sessionId,
          commandAction: {
            approveArgs: ['plugin', 'reinstall', source],
            actionKey: step.actionKey,
            allowSession: step.allowSession,
            allowAgent: step.allowAgent,
            allowAll: step.allowAll,
            denyTitle: 'Plugin Reinstall Cancelled',
            denyText: `Cancelled plugin reinstall for \`${source}\`.`,
          },
        });
        return infoCommand('Pending Approval', step.prompt);
      }
      return badCommand(
        'Plugin Reinstall Failed',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (sub === 'check') {
    const pluginId = String(req.args[2] || '').trim();
    if (!pluginId) {
      return badCommand('Usage', 'Usage: `plugin check <plugin-id>`');
    }
    if (!isLocalSession(req)) {
      return badCommand(
        'Plugin Check Restricted',
        '`plugin check` is only available from local TUI/web sessions.',
      );
    }
    try {
      const result = await checkPlugin(pluginId);
      return infoCommand(
        'Plugin Check',
        buildPluginCheckLines(result).join('\n'),
      );
    } catch (error) {
      return badCommand(
        'Plugin Check Failed',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (sub === 'uninstall') {
    const pluginId = String(req.args[2] || '').trim();
    if (!pluginId) {
      return badCommand(
        'Usage',
        'Usage: `plugin list|enable <plugin-id>|disable <plugin-id>|install <path|plugin-id|npm-spec> [--yes]|reinstall <path|plugin-id|npm-spec> [--yes]|check <plugin-id>|uninstall <plugin-id>`',
      );
    }
    try {
      const result = await uninstallPlugin(pluginId);
      await shutdownPluginManager();
      const lines = [
        result.removedPluginDir
          ? `Uninstalled plugin \`${result.pluginId}\` from \`${result.pluginDir}\`.`
          : `Removed plugin overrides for \`${result.pluginId}\`; no home install existed at \`${result.pluginDir}\`.`,
        result.removedConfigOverrides > 0
          ? `Removed ${result.removedConfigOverrides} matching \`plugins.list[]\` override${result.removedConfigOverrides === 1 ? '' : 's'}.`
          : 'No matching `plugins.list[]` overrides were removed.',
        'Plugin runtime will reload on the next turn.',
      ];
      return infoCommand('Plugin Uninstalled', lines.join('\n'));
    } catch (error) {
      return badCommand(
        'Plugin Uninstall Failed',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (sub === 'reload') {
    const reloadResult = await reloadPluginRuntime();
    if (!reloadResult.ok) {
      return badCommand('Plugin Reload Failed', reloadResult.message);
    }
    return infoCommand('Plugins Reloaded', reloadResult.message);
  }

  return badCommand(
    'Usage',
    'Usage: `plugin list|config <plugin-id> [key] [value|--unset]|enable <plugin-id>|disable <plugin-id>|install <path|plugin-id|npm-spec> [--yes]|reinstall <path|plugin-id|npm-spec> [--yes]|check <plugin-id>|reload|uninstall <plugin-id>`',
  );
}

function normalizePluginCommandResult(value: unknown): GatewayCommandResult {
  if (typeof value === 'string') {
    return { kind: 'plain', text: value };
  }
  if (value == null) {
    return { kind: 'plain', text: '' };
  }
  return { kind: 'plain', text: JSON.stringify(value, null, 2) };
}

export async function tryHandlePluginDefinedGatewayCommand(params: {
  command: string;
  req: GatewayCommandRequest;
  pluginManager: PluginManager | null;
}): Promise<GatewayCommandResult | null> {
  const pluginCommand = params.pluginManager?.findCommand(params.command);
  if (!pluginCommand) {
    return null;
  }
  try {
    return normalizePluginCommandResult(
      await pluginCommand.handler(params.req.args.slice(1), {
        sessionId: params.req.sessionId,
        channelId: params.req.channelId,
        userId: params.req.userId,
        username: params.req.username ?? null,
        guildId: params.req.guildId ?? null,
      }),
    );
  } catch (error) {
    return badCommand(
      'Plugin Command Failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function getGatewayAdminPlugins(): Promise<GatewayAdminPluginsResponse> {
  const pluginManager = await ensurePluginManagerInitialized();
  const plugins = pluginManager
    .listPluginSummary()
    .map((plugin) => ({
      id: plugin.id,
      name: plugin.name || null,
      version: plugin.version || null,
      description: plugin.description || null,
      source: plugin.source,
      enabled: plugin.enabled,
      status: plugin.error ? ('failed' as const) : ('loaded' as const),
      error: plugin.error || null,
      commands: [...plugin.commands].sort((left, right) =>
        left.localeCompare(right),
      ),
      tools: [...plugin.tools].sort((left, right) => left.localeCompare(right)),
      hooks: [...plugin.hooks].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    totals: {
      totalPlugins: plugins.length,
      enabledPlugins: plugins.filter((plugin) => plugin.enabled).length,
      failedPlugins: plugins.filter((plugin) => plugin.status === 'failed')
        .length,
      commands: plugins.reduce(
        (sum, plugin) => sum + plugin.commands.length,
        0,
      ),
      tools: plugins.reduce((sum, plugin) => sum + plugin.tools.length, 0),
      hooks: plugins.reduce((sum, plugin) => sum + plugin.hooks.length, 0),
    },
    plugins,
  };
}

export async function handleGatewayPluginWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (!isPluginInboundWebhookPath(url.pathname)) {
    sendWebhookJson(res, 404, { error: 'Not Found' });
    return;
  }

  const { pluginManager } = await tryEnsurePluginManagerInitializedForGateway({
    sessionId: `plugin-webhook:${url.pathname}`,
    channelId: url.pathname,
    surface: 'webhook',
  });
  if (!pluginManager) {
    sendWebhookJson(res, 503, {
      error: 'Plugin manager unavailable.',
    });
    return;
  }

  try {
    const handled = await pluginManager.handleInboundWebhook({
      method: req.method || 'GET',
      pathname: url.pathname,
      url,
      req,
      res,
    });
    if (!handled) {
      sendWebhookJson(res, 404, { error: 'Plugin webhook not found.' });
    }
  } catch (error) {
    if (error instanceof WebhookHttpError) {
      sendWebhookJson(res, error.statusCode, { error: error.message });
      return;
    }
    throw error;
  }
}

export async function runGatewayPluginTool(params: {
  toolName: string;
  args: Record<string, unknown>;
  sessionId?: string;
  channelId?: string;
}): Promise<string> {
  const pluginManager = await ensurePluginManagerInitialized();
  return pluginManager.executeTool({
    toolName: params.toolName,
    args: params.args,
    sessionId: String(params.sessionId || '').trim(),
    channelId: String(params.channelId || '').trim(),
  });
}
