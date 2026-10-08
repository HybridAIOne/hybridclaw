/**
 * Runs a top-level `hybridclaw <name>` command that a plugin declares in its
 * manifest's `cliCommands`, for names no built-in command handles.
 *
 * Routing reads manifests only: the one plugin that declares the name is
 * imported, register-only (no services, memory layers or gateway hooks), and
 * no other plugin's code runs, so a typo or an unrelated broken plugin costs
 * nothing. Plugin-manager logs go to stderr at error level so the command's
 * stdout stays its own. Returns false when no manifest declares the name; it
 * never falls through to a different command.
 */
import pino from 'pino';
import type { PluginManager } from '../plugins/plugin-manager.js';
import type { PluginCandidate } from '../plugins/plugin-types.js';

async function createCliPluginManager(): Promise<PluginManager> {
  const { PluginManager } = await import('../plugins/plugin-manager.js');
  return new PluginManager({
    logger: pino({ level: 'error' }, pino.destination(2)),
  });
}

async function discoverCliCommandPlugins(
  manager: PluginManager,
): Promise<PluginCandidate[]> {
  return (await manager.discoverPlugins()).filter(
    (candidate) => (candidate.manifest.cliCommands?.length ?? 0) > 0,
  );
}

export async function runPluginCliCommand(
  name: string,
  args: string[],
): Promise<boolean> {
  const manager = await createCliPluginManager();
  const owners = (await discoverCliCommandPlugins(manager)).filter(
    (candidate) =>
      candidate.manifest.cliCommands?.some((command) => command.name === name),
  );
  if (owners.length === 0) return false;
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
    await discoverCliCommandPlugins(await createCliPluginManager())
  ).flatMap((candidate) => candidate.manifest.cliCommands ?? []);
  if (commands.length === 0) return;
  console.log('\n  Plugin commands:');
  for (const command of commands) {
    console.log(`  ${command.name.padEnd(10)} ${command.description}`);
  }
}
