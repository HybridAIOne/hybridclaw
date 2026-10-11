/**
 * The answer to a slash command no built-in or loaded plugin handles, when a
 * plugin manifest declares it in `commands`: names the plugin and the install
 * or enable command, or why an enabled one did not load, instead of
 * "Unknown command". Reads manifests only; never loads or runs a plugin.
 * NOT the plugin command dispatcher (`tryHandlePluginDefinedGatewayCommand`).
 */
import pino from 'pino';
import {
  describeUnloadedPluginCommandOwner,
  findUnloadedPluginCommandOwner,
} from '../plugins/plugin-command-owner.js';
import {
  findPluginLoadError,
  PluginManager,
} from '../plugins/plugin-manager.js';
import type { PluginManifest } from '../plugins/plugin-types.js';

export async function describeMissingPluginCommand(
  name: string,
): Promise<string | null> {
  if (!name) return null;
  // Its own manager so discovery warnings are not logged per unknown command.
  const manager = new PluginManager({ logger: pino({ level: 'silent' }) });
  const declares = (manifest: PluginManifest) =>
    manifest.commands?.includes(name) ?? false;
  const subject = `\`/${name}\``;
  const enabled = (await manager.discoverPlugins()).find((candidate) =>
    declares(candidate.manifest),
  );
  if (enabled) {
    const reason =
      findPluginLoadError(enabled.id) ??
      `run \`hybridclaw plugin check ${enabled.id}\` for details`;
    return `${subject} is provided by the "${enabled.id}" plugin, which did not load: ${reason}`;
  }
  const owner = await findUnloadedPluginCommandOwner(manager, declares);
  return owner ? describeUnloadedPluginCommandOwner(subject, owner) : null;
}
