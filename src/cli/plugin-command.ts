import readline from 'node:readline/promises';
import { runtimeConfigPath } from '../config/runtime-config.js';
import { formatPluginSummaryList } from '../plugins/plugin-formatting.js';
import { normalizeArgs } from './common.js';
import { isHelpRequest, printPluginUsage } from './help.js';

function formatDependencyPlanDetails(plan: {
  usesPackageJson: boolean;
  nodePackages: string[];
  pipPackages: string[];
}): string {
  const parts: string[] = [];
  if (plan.usesPackageJson) {
    parts.push('npm install from package.json');
  }
  if (plan.nodePackages.length > 0) {
    parts.push(`npm packages: ${plan.nodePackages.join(', ')}`);
  }
  if (plan.pipPackages.length > 0) {
    parts.push(`pip packages: ${plan.pipPackages.join(', ')}`);
  }
  return parts.join('; ');
}

async function confirmDependencyInstall(plan: {
  usesPackageJson: boolean;
  nodePackages: string[];
  pipPackages: string[];
}): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Plugin dependency installation requires an interactive terminal. Re-run with --yes to approve.',
    );
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(
      `Install plugin dependencies (${formatDependencyPlanDetails(plan)})? [y/N] `,
    );
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
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

function printMissingBinaryGuidance(
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
): void {
  if (!missingRequiredBins || missingRequiredBins.length === 0) return;

  console.log(
    `Missing required binaries right now: ${missingRequiredBins.map((entry) => formatMissingBinaryRequirement(entry)).join(', ')}`,
  );
  for (const entry of missingRequiredBins) {
    if (entry.installHint) {
      console.log(`Install ${entry.name}: ${entry.installHint}`);
    }
    if (entry.installUrl) {
      console.log(`Install docs for ${entry.name}: ${entry.installUrl}`);
    }
    if (entry.configKey) {
      console.log(
        `If ${entry.name} is installed outside PATH, set it with: hybridclaw plugin config ${pluginId} ${entry.configKey} /absolute/path/to/${entry.name}`,
      );
    }
  }
  console.log(
    'Until the missing binaries are installed, the plugin will remain unavailable.',
  );
}

function printDependencyInstallSummary(params: {
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
}): void {
  if (params.dependencySummary.usedPackageJson) {
    console.log('Installed plugin Node.js dependencies from package.json.');
  }
  if (params.dependencySummary.installedNodePackages.length > 0) {
    console.log(
      `Installed plugin npm packages: ${params.dependencySummary.installedNodePackages.join(', ')}.`,
    );
  }
  if (params.dependencySummary.installedPipPackages.length > 0) {
    console.log(
      `Installed plugin pip packages: ${params.dependencySummary.installedPipPackages.join(', ')}.`,
    );
  }
  for (const entry of params.configuredRequiredBins) {
    console.log(
      `Configured ${entry.name} via ${entry.configKey} = ${entry.command}.`,
    );
  }
  for (const entry of params.externalDependencies.filter(
    (dependency) => !dependency.installed,
  )) {
    console.log(`External dependency check failed for ${entry.name}.`);
    if (entry.installHint) {
      console.log(`Install ${entry.name}: ${entry.installHint}`);
    }
    if (entry.installUrl) {
      console.log(`Install docs for ${entry.name}: ${entry.installUrl}`);
    }
  }
}

function printPluginCheckReport(result: {
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
    check: string;
    installed: boolean;
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
}): void {
  console.log(`Plugin: ${result.pluginId}`);
  console.log(`Directory: ${result.pluginDir}`);
  console.log(`Source: ${result.source}`);
  if (result.requiresEnv.length > 0) {
    console.log(`Required env vars: ${result.requiresEnv.join(', ')}`);
  }
  if (result.missingEnv.length > 0) {
    console.log(`Missing env vars: ${result.missingEnv.join(', ')}`);
  }
  if (result.packageJsonDependencies.length > 0) {
    console.log(
      `package.json dependencies: ${result.packageJsonDependencies.map((entry) => `${entry.package}=${entry.installed ? 'ok' : 'missing'}`).join(', ')}`,
    );
  }
  if (result.nodeDependencies.length > 0) {
    console.log(
      `Manifest npm dependencies: ${result.nodeDependencies.map((entry) => `${entry.package}=${entry.installed ? 'ok' : 'missing'}`).join(', ')}`,
    );
  }
  if (result.pipDependencies.length > 0) {
    console.log(
      `Manifest pip dependencies: ${result.pipDependencies.map((entry) => `${entry.package}=${entry.installed ? 'ok' : 'missing'}`).join(', ')}`,
    );
  }
  if (result.externalDependencies.length > 0) {
    console.log(
      `External dependencies: ${result.externalDependencies.map((entry) => `${entry.name}=${entry.installed ? 'ok' : 'missing'}`).join(', ')}`,
    );
  }
  if (result.configuredRequiredBins.length > 0) {
    console.log(
      `Configured binary paths: ${result.configuredRequiredBins.map((entry) => `${entry.name} (${entry.configKey}=${entry.command})`).join(', ')}`,
    );
  }
  printMissingBinaryGuidance(result.pluginId, result.missingRequiredBins);
  if (result.requiredConfigKeys.length > 0) {
    console.log(
      `Required config keys: ${result.requiredConfigKeys.join(', ')}`,
    );
  }
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

export async function handlePluginCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printPluginUsage();
    return;
  }

  const sub = normalized[0].toLowerCase();
  if (sub === 'list') {
    if (normalized.length !== 1) {
      printPluginUsage();
      throw new Error(
        'Unexpected extra arguments for `hybridclaw plugin list`.',
      );
    }

    const { ensurePluginManagerInitialized } = await import(
      '../plugins/plugin-manager.js'
    );
    const manager = await ensurePluginManagerInitialized();
    console.log(formatPluginSummaryList(manager.listPluginSummary()));
    return;
  }

  if (sub === 'config') {
    const pluginId = normalized[1];
    const key = normalized[2];
    const rawValue = normalized.slice(3).join(' ').trim();
    if (!pluginId) {
      printPluginUsage();
      throw new Error(
        'Missing plugin id for `hybridclaw plugin config <plugin-id> [key] [value|--unset]`.',
      );
    }

    const {
      readPluginConfigEntry,
      readPluginConfigValue,
      unsetPluginConfigValue,
      writePluginConfigValue,
    } = await import('../plugins/plugin-config.js');

    if (!key) {
      const result = readPluginConfigEntry(pluginId);
      console.log(`Plugin: ${result.pluginId}`);
      console.log(`Config file: ${result.configPath}`);
      console.log(
        `Override: ${result.entry ? formatPluginConfigValue(result.entry) : '(none)'}`,
      );
      return;
    }

    if (!rawValue) {
      const result = readPluginConfigValue(pluginId, key);
      console.log(`Plugin: ${result.pluginId}`);
      console.log(`Key: ${result.key}`);
      console.log(`Value: ${formatPluginConfigValue(result.value)}`);
      console.log(`Config file: ${result.configPath}`);
      return;
    }

    const result =
      rawValue === '--unset'
        ? await unsetPluginConfigValue(pluginId, key)
        : await writePluginConfigValue(pluginId, key, rawValue);
    console.log(
      result.removed
        ? result.changed
          ? `Removed plugin config ${result.pluginId}.${result.key}.`
          : `Plugin config ${result.pluginId}.${result.key} was already unset.`
        : `Set plugin config ${result.pluginId}.${result.key} = ${formatPluginConfigValue(result.value)}.`,
    );
    console.log(`Updated runtime config at ${result.configPath}.`);
    console.log(
      'Restart the gateway to load plugin config changes if it is running:',
    );
    console.log('  hybridclaw gateway restart --foreground');
    console.log('  hybridclaw gateway status');
    return;
  }

  if (sub === 'enable' || sub === 'disable') {
    const pluginId = normalized[1];
    if (!pluginId) {
      printPluginUsage();
      throw new Error(
        `Missing plugin id for \`hybridclaw plugin ${sub} <plugin-id>\`.`,
      );
    }
    if (normalized.length !== 2) {
      printPluginUsage();
      throw new Error(
        `Unexpected extra arguments for \`hybridclaw plugin ${sub} <plugin-id>\`.`,
      );
    }

    const { setPluginEnabled } = await import('../plugins/plugin-config.js');
    const enabled = sub === 'enable';
    const result = await setPluginEnabled(pluginId, enabled);
    console.log(
      result.changed
        ? `${enabled ? 'Enabled' : 'Disabled'} plugin ${result.pluginId}.`
        : `Plugin ${result.pluginId} was already ${enabled ? 'enabled' : 'disabled'}.`,
    );
    if (result.changed) {
      console.log(`Updated runtime config at ${result.configPath}.`);
    }
    console.log(
      'Restart the gateway to load plugin config changes if it is running:',
    );
    console.log('  hybridclaw gateway restart --foreground');
    console.log('  hybridclaw gateway status');
    return;
  }

  if (sub === 'install') {
    const source = normalized[1];
    if (!source) {
      printPluginUsage();
      throw new Error(
        'Missing plugin source for `hybridclaw plugin install <path|plugin-id|npm-spec> [--yes]`.',
      );
    }
    const yes = normalized[2];
    if (normalized.length > 3 || (yes && yes !== '--yes')) {
      printPluginUsage();
      throw new Error(
        'Unexpected extra arguments for `hybridclaw plugin install <path|plugin-id|npm-spec> [--yes]`.',
      );
    }

    const { installPlugin } = await import('../plugins/plugin-install.js');
    let result: Awaited<ReturnType<typeof installPlugin>>;
    try {
      result = await installPlugin(source, {
        approveDependencyInstall: yes === '--yes',
      });
    } catch (error) {
      if (isDependencyApprovalRequiredError(error)) {
        if (yes === '--yes') throw error;
        const confirmed = await confirmDependencyInstall(error.plan);
        if (!confirmed) {
          console.log('Plugin install cancelled.');
          return;
        }
        result = await installPlugin(source, {
          approveDependencyInstall: true,
        });
      } else {
        throw error;
      }
    }

    if (result.alreadyInstalled) {
      console.log(
        `Plugin ${result.pluginId} is already present at ${result.pluginDir}.`,
      );
    } else {
      console.log(
        `Installed plugin ${result.pluginId} to ${result.pluginDir}.`,
      );
    }
    printDependencyInstallSummary(result);
    console.log(
      `Plugin ${result.pluginId} will auto-discover from ${result.pluginDir}.`,
    );
    printMissingBinaryGuidance(result.pluginId, result.missingRequiredBins);
    if (result.requiresEnv.length > 0) {
      console.log(`Required env vars: ${result.requiresEnv.join(', ')}`);
    }
    if (result.requiredConfigKeys.length > 0) {
      console.log(
        `Add a plugins.list[] override in ${runtimeConfigPath()} to set required config keys: ${result.requiredConfigKeys.join(', ')}`,
      );
    } else {
      console.log(
        `No config entry is required unless you want plugin overrides in ${runtimeConfigPath()}.`,
      );
    }
    console.log('Restart the gateway to load plugin changes:');
    console.log('  hybridclaw gateway restart --foreground');
    console.log('  hybridclaw gateway status');
    return;
  }

  if (sub === 'reinstall') {
    const source = normalized[1];
    if (!source) {
      printPluginUsage();
      throw new Error(
        'Missing plugin source for `hybridclaw plugin reinstall <path|plugin-id|npm-spec> [--yes]`.',
      );
    }
    const yes = normalized[2];
    if (normalized.length > 3 || (yes && yes !== '--yes')) {
      printPluginUsage();
      throw new Error(
        'Unexpected extra arguments for `hybridclaw plugin reinstall <path|plugin-id|npm-spec> [--yes]`.',
      );
    }

    const { reinstallPlugin } = await import('../plugins/plugin-install.js');
    let result: Awaited<ReturnType<typeof reinstallPlugin>>;
    try {
      result = await reinstallPlugin(source, {
        approveDependencyInstall: yes === '--yes',
      });
    } catch (error) {
      if (isDependencyApprovalRequiredError(error)) {
        if (yes === '--yes') throw error;
        const confirmed = await confirmDependencyInstall(error.plan);
        if (!confirmed) {
          console.log('Plugin reinstall cancelled.');
          return;
        }
        result = await reinstallPlugin(source, {
          approveDependencyInstall: true,
        });
      } else {
        throw error;
      }
    }

    if (result.replacedExistingInstall) {
      console.log(
        `Reinstalled plugin ${result.pluginId} to ${result.pluginDir}.`,
      );
    } else {
      console.log(
        `Installed plugin ${result.pluginId} to ${result.pluginDir}.`,
      );
    }
    printDependencyInstallSummary(result);
    console.log(
      `Plugin ${result.pluginId} will auto-discover from ${result.pluginDir}.`,
    );
    printMissingBinaryGuidance(result.pluginId, result.missingRequiredBins);
    if (result.requiresEnv.length > 0) {
      console.log(`Required env vars: ${result.requiresEnv.join(', ')}`);
    }
    if (result.requiredConfigKeys.length > 0) {
      console.log(
        `Add a plugins.list[] override in ${runtimeConfigPath()} to set required config keys: ${result.requiredConfigKeys.join(', ')}`,
      );
    } else {
      console.log(
        `No config entry is required unless you want plugin overrides in ${runtimeConfigPath()}.`,
      );
    }
    console.log('Restart the gateway to load plugin changes:');
    console.log('  hybridclaw gateway restart --foreground');
    console.log('  hybridclaw gateway status');
    return;
  }

  if (sub === 'check') {
    const pluginId = normalized[1];
    if (!pluginId) {
      printPluginUsage();
      throw new Error(
        'Missing plugin id for `hybridclaw plugin check <plugin-id>`.',
      );
    }
    if (normalized.length !== 2) {
      printPluginUsage();
      throw new Error(
        'Unexpected extra arguments for `hybridclaw plugin check <plugin-id>`.',
      );
    }

    const { checkPlugin } = await import('../plugins/plugin-install.js');
    const result = await checkPlugin(pluginId);
    printPluginCheckReport(result);
    return;
  }

  if (sub === 'uninstall') {
    const pluginId = normalized[1];
    if (!pluginId) {
      printPluginUsage();
      throw new Error(
        'Missing plugin id for `hybridclaw plugin uninstall <plugin-id>`.',
      );
    }
    if (normalized.length !== 2) {
      printPluginUsage();
      throw new Error(
        'Unexpected extra arguments for `hybridclaw plugin uninstall <plugin-id>`.',
      );
    }

    const { uninstallPlugin } = await import('../plugins/plugin-install.js');
    const result = await uninstallPlugin(pluginId);
    if (result.removedPluginDir) {
      console.log(
        `Uninstalled plugin ${result.pluginId} from ${result.pluginDir}.`,
      );
    } else {
      console.log(
        `Removed plugin overrides for ${result.pluginId}; no installed plugin directory was present at ${result.pluginDir}.`,
      );
    }
    if (result.removedConfigOverrides > 0) {
      const label =
        result.removedConfigOverrides === 1 ? 'override' : 'overrides';
      console.log(
        `Removed ${result.removedConfigOverrides} plugins.list[] ${label} from ${runtimeConfigPath()}.`,
      );
    } else {
      console.log(
        `No plugins.list[] overrides were removed from ${runtimeConfigPath()}.`,
      );
    }
    console.log(
      'Restart the gateway to unload plugin changes if it is running:',
    );
    console.log('  hybridclaw gateway restart --foreground');
    console.log('  hybridclaw gateway status');
    return;
  }

  printPluginUsage();
  throw new Error(
    `Unknown plugin subcommand: ${sub}. Use \`hybridclaw plugin list\`, \`hybridclaw plugin config <plugin-id> [key] [value|--unset]\`, \`hybridclaw plugin enable <plugin-id>\`, \`hybridclaw plugin disable <plugin-id>\`, \`hybridclaw plugin install <path|plugin-id|npm-spec> [--yes]\`, \`hybridclaw plugin reinstall <path|plugin-id|npm-spec> [--yes]\`, \`hybridclaw plugin check <plugin-id>\`, or \`hybridclaw plugin uninstall <plugin-id>\`.`,
  );
}
