/**
 * Runs a top-level `hybridclaw <name>` command that a plugin registered with
 * `registerCliCommand`, for names no built-in command handles.
 *
 * Plugins are loaded register-only: no services, memory layers or gateway
 * lifecycle hooks start in the CLI process. The runtime database is opened
 * the way built-in commands open it. Returns false when no plugin owns the
 * name; it never falls through to a different command.
 */
export async function runPluginCliCommand(
  name: string,
  args: string[],
): Promise<boolean> {
  const { PluginManager } = await import('../plugins/plugin-manager.js');
  const manager = new PluginManager();
  try {
    for (const candidate of await manager.discoverPlugins()) {
      await manager.loadPlugin(candidate);
    }
    const entry = manager.cliCommands.find(name);
    if (!entry) return false;
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
