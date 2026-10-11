/**
 * Runs a top-level `hybridclaw <name>` command that a plugin declares in its
 * manifest's `cliCommands`, for names no built-in command handles.
 *
 * Routing reads manifests only: the one plugin that declares the name is
 * imported, register-only (no services, memory layers or gateway hooks), and
 * no other plugin's code runs, so a typo or an unrelated broken plugin costs
 * nothing. Plugin-manager logs go to stderr at error level so the command's
 * stdout stays its own. Project plugins (`<cwd>/.hybridclaw/plugins`) never
 * provide CLI commands, so running a command inside an untrusted checkout
 * cannot execute that checkout's code. A name only a disabled plugin declares
 * fails with the enable command, one only a bundled plugin that is not
 * installed declares fails with the install command, and a plugin's gateway
 * slash command fails with its `hybridclaw gateway <name>` form. Returns false
 * when no manifest declares the name; it never falls through to a different
 * command.
 */
import pino from 'pino';
import {
  describeUnloadedPluginCommandOwner,
  findUnloadedPluginCommandOwner,
} from '../plugins/plugin-command-owner.js';
import { PluginManager } from '../plugins/plugin-manager.js';
import type {
  PluginCandidate,
  PluginManifest,
} from '../plugins/plugin-types.js';

function createCliPluginManager(): PluginManager {
  return new PluginManager({
    logger: pino({ level: 'error' }, pino.destination(2)),
    includeProjectPlugins: false,
  });
}

async function discoverCliCommandPlugins(
  manager: PluginManager,
): Promise<PluginCandidate[]> {
  return (await manager.discoverPlugins()).filter(
    (candidate) => (candidate.manifest.cliCommands?.length ?? 0) > 0,
  );
}

function declaresCliCommand(manifest: PluginManifest, name: string): boolean {
  return (
    manifest.cliCommands?.some((command) => command.name === name) ?? false
  );
}

// A gateway slash command typed as a top-level CLI command (`browser-pool`
// used to be one) points at `hybridclaw gateway <name>`, which in turn names
// the install or enable command when its plugin is not loaded.
async function findGatewayCommandOwner(
  manager: PluginManager,
  name: string,
): Promise<string | null> {
  const declares = (manifest: PluginManifest) =>
    manifest.commands?.includes(name) ?? false;
  const enabled = (await manager.discoverPlugins()).find((candidate) =>
    declares(candidate.manifest),
  );
  return (
    enabled?.id ??
    (await findUnloadedPluginCommandOwner(manager, declares))?.pluginId ??
    null
  );
}

export async function runPluginCliCommand(
  name: string,
  args: string[],
): Promise<boolean> {
  const manager = createCliPluginManager();
  const owners = (await discoverCliCommandPlugins(manager)).filter(
    (candidate) => declaresCliCommand(candidate.manifest, name),
  );
  if (owners.length === 0) {
    const unloaded = await findUnloadedPluginCommandOwner(manager, (manifest) =>
      declaresCliCommand(manifest, name),
    );
    if (unloaded) {
      throw new Error(
        describeUnloadedPluginCommandOwner(`\`${name}\``, unloaded),
      );
    }
    const gatewayOwner = await findGatewayCommandOwner(manager, name);
    if (!gatewayOwner) return false;
    throw new Error(
      `\`${name}\` is a gateway command of the "${gatewayOwner}" plugin. Run \`${['hybridclaw gateway', name, ...args].join(' ')}\`.`,
    );
  }
  if (owners.length > 1) {
    throw new Error(
      `CLI command "${name}" is declared by plugins ${owners.map((owner) => `"${owner.id}"`).join(' and ')}; disable all but one with \`hybridclaw plugin disable <id>\`.`,
    );
  }
  const [owner] = owners;
  try {
    await manager.loadPlugin(owner);
    const entry = manager.cliCommands.find(name);
    if (!entry) {
      const failure = manager
        .listPluginSummary()
        .find((plugin) => plugin.id === owner.id)?.error;
      throw new Error(
        `Plugin "${owner.id}" provides \`${name}\` but did not load: ${failure || `run \`hybridclaw plugin check ${owner.id}\` for details`}`,
      );
    }
    const { initDatabase, isDatabaseInitialized } = await import(
      '../memory/db.js'
    );
    if (!isDatabaseInitialized()) initDatabase({ quiet: true });
    await entry.command.run(args);
    return true;
  } finally {
    await manager.shutdown();
  }
}

/** Lists installed plugin commands for the main usage text, from manifests. */
export async function printPluginCliCommandUsage(): Promise<void> {
  const commands = (
    await discoverCliCommandPlugins(createCliPluginManager())
  ).flatMap((candidate) => candidate.manifest.cliCommands ?? []);
  if (commands.length === 0) return;
  console.log('\n  Plugin commands:');
  for (const command of commands) {
    console.log(`  ${command.name.padEnd(10)} ${command.description}`);
  }
}
