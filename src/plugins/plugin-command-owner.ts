/**
 * Names the plugin behind a command nothing loaded handles, from manifests.
 *
 * Answers only "which disabled or not-installed plugin declares this", so a
 * missing command can say what to enable or install instead of "unknown".
 * It reads manifests and never imports plugin code. NOT the dispatcher: the
 * CLI (`cli/plugin-cli-dispatch.ts`) and the gateway route commands of loaded
 * plugins themselves, and a plugin that is enabled but failed to load is
 * their concern.
 */
import path from 'node:path';
import { listBundledInstallablePlugins } from './plugin-install.js';
import type { PluginManager } from './plugin-manager.js';
import { loadPluginManifest, MANIFEST_FILE_NAME } from './plugin-manager.js';
import type { PluginManifest } from './plugin-types.js';

export interface UnloadedPluginCommandOwner {
  pluginId: string;
  state: 'disabled' | 'not-installed';
}

// `enabled: false` in plugins.list[] is the disabled state; discovering with
// those entries switched on finds what they would load, from any source.
async function findDisabledOwner(
  manager: PluginManager,
  declares: (manifest: PluginManifest) => boolean,
): Promise<string | null> {
  const config = structuredClone(manager.getConfig());
  const disabled = config.plugins.list.filter(
    (entry) => entry.enabled === false,
  );
  if (disabled.length === 0) return null;
  for (const entry of disabled) entry.enabled = true;
  const disabledIds = new Set(disabled.map((entry) => entry.id));
  const owner = (await manager.discoverPlugins(config)).find(
    (candidate) =>
      disabledIds.has(candidate.id) && declares(candidate.manifest),
  );
  return owner?.id ?? null;
}

function findNotInstalledBundledOwner(
  declares: (manifest: PluginManifest) => boolean,
): string | null {
  for (const plugin of listBundledInstallablePlugins()) {
    const manifest = loadPluginManifest(
      path.join(plugin.dir, MANIFEST_FILE_NAME),
    );
    if (declares(manifest)) return plugin.id;
  }
  return null;
}

/** Call only after the enabled plugins were found not to declare the command. */
export async function findUnloadedPluginCommandOwner(
  manager: PluginManager,
  declares: (manifest: PluginManifest) => boolean,
): Promise<UnloadedPluginCommandOwner | null> {
  const disabled = await findDisabledOwner(manager, declares);
  if (disabled) return { pluginId: disabled, state: 'disabled' };
  const bundled = findNotInstalledBundledOwner(declares);
  if (bundled) return { pluginId: bundled, state: 'not-installed' };
  return null;
}

/** `subject` is how the user typed the command, e.g. "`coworker`" or "`/voice`". */
export function describeUnloadedPluginCommandOwner(
  subject: string,
  owner: UnloadedPluginCommandOwner,
): string {
  const id = owner.pluginId;
  return owner.state === 'disabled'
    ? `${subject} is provided by the "${id}" plugin, which is disabled. Enable it with \`hybridclaw plugin enable ${id}\`.`
    : `${subject} is provided by the bundled "${id}" plugin, which is not installed. Install it with \`hybridclaw plugin install ${id}\`.`;
}
