import { runtimeConfigPath } from '../config/runtime-config.js';
import { formatPluginSummaryList } from '../plugins/plugin-formatting.js';
import { normalizeArgs } from './common.js';
import { isHelpRequest, printPluginUsage } from './help.js';

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
        'Missing plugin source for `hybridclaw plugin install <path|npm-spec>`.',
      );
    }
    if (normalized.length !== 2) {
      printPluginUsage();
      throw new Error(
        'Unexpected extra arguments for `hybridclaw plugin install <path|npm-spec>`.',
      );
    }

    const { installPlugin } = await import('../plugins/plugin-install.js');
    const result = await installPlugin(source);

    if (result.alreadyInstalled) {
      console.log(
        `Plugin ${result.pluginId} is already present at ${result.pluginDir}.`,
      );
    } else {
      console.log(
        `Installed plugin ${result.pluginId} to ${result.pluginDir}.`,
      );
    }
    if (result.dependenciesInstalled) {
      console.log('Installed plugin npm dependencies.');
    }
    console.log(
      `Plugin ${result.pluginId} will auto-discover from ${result.pluginDir}.`,
    );
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
        'Missing plugin source for `hybridclaw plugin reinstall <path|npm-spec>`.',
      );
    }
    if (normalized.length !== 2) {
      printPluginUsage();
      throw new Error(
        'Unexpected extra arguments for `hybridclaw plugin reinstall <path|npm-spec>`.',
      );
    }

    const { reinstallPlugin } = await import('../plugins/plugin-install.js');
    const result = await reinstallPlugin(source);

    if (result.replacedExistingInstall) {
      console.log(
        `Reinstalled plugin ${result.pluginId} to ${result.pluginDir}.`,
      );
    } else {
      console.log(
        `Installed plugin ${result.pluginId} to ${result.pluginDir}.`,
      );
    }
    if (result.dependenciesInstalled) {
      console.log('Installed plugin npm dependencies.');
    }
    console.log(
      `Plugin ${result.pluginId} will auto-discover from ${result.pluginDir}.`,
    );
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
    `Unknown plugin subcommand: ${sub}. Use \`hybridclaw plugin list\`, \`hybridclaw plugin config <plugin-id> [key] [value|--unset]\`, \`hybridclaw plugin enable <plugin-id>\`, \`hybridclaw plugin disable <plugin-id>\`, \`hybridclaw plugin install <path|npm-spec>\`, \`hybridclaw plugin reinstall <path|npm-spec>\`, or \`hybridclaw plugin uninstall <plugin-id>\`.`,
  );
}
