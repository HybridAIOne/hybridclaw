/**
 * Plugin CLI command table — one owner per top-level `hybridclaw <name>`.
 *
 * The manifest's `cliCommands` is the source of truth: the CLI routes a name
 * to the one plugin whose manifest declares it and imports only that plugin,
 * and `register` rejects a command the manifest does not declare. The CLI
 * consults it only for a name no built-in command handles, so a plugin can
 * add commands but never replace one. NOT the gateway slash-command table
 * (`registerCommand`); these run in the CLI process, not in a session. The
 * manifest's `commands` (gateway slash-command names) is parsed here too, so
 * both kinds share one naming rule.
 */
import type {
  PluginCliCommandDefinition,
  PluginManifestCliCommand,
} from './plugin-types.js';

const COMMAND_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** Shared by `cliCommands` and the gateway slash commands in `commands`. */
export function assertPluginCommandName(
  owner: string,
  kind: 'CLI command' | 'command',
  name: string,
): void {
  if (!COMMAND_NAME_RE.test(name)) {
    throw new Error(
      `Plugin "${owner}" ${kind} name "${name}" must be lowercase letters, digits, and dashes.`,
    );
  }
}

/** Parses manifest `cliCommands`; a malformed entry makes the manifest invalid. */
export function normalizeManifestCliCommands(
  pluginId: string,
  value: unknown,
): PluginManifestCliCommand[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Plugin "${pluginId}" \`cliCommands\` must be a list.`);
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const name = String(record.name ?? '').trim();
    const description = String(record.description ?? '').trim();
    assertPluginCommandName(pluginId, 'CLI command', name);
    if (!description) {
      throw new Error(
        `Plugin "${pluginId}" CLI command "${name}" needs a description.`,
      );
    }
    if (seen.has(name)) {
      throw new Error(
        `Plugin "${pluginId}" declares CLI command "${name}" twice.`,
      );
    }
    seen.add(name);
    return { name, description };
  });
}

/**
 * Parses manifest `commands`, the gateway slash commands a plugin provides.
 * Only names: the description comes from `registerCommand` once loaded; the
 * names let the gateway name the plugin when it is not loaded.
 */
export function normalizeManifestCommands(
  pluginId: string,
  value: unknown,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Plugin "${pluginId}" \`commands\` must be a list.`);
  }
  const names = value.map((entry) => String(entry ?? '').trim());
  for (const name of names) assertPluginCommandName(pluginId, 'command', name);
  if (new Set(names).size !== names.length) {
    throw new Error(`Plugin "${pluginId}" declares a command twice.`);
  }
  return names;
}

export interface RegisteredPluginCliCommand {
  pluginId: string;
  command: PluginCliCommandDefinition;
}

export class PluginCliCommandRegistry {
  private entries = new Map<string, RegisteredPluginCliCommand>();

  register(
    pluginId: string,
    command: PluginCliCommandDefinition,
    declared: readonly PluginManifestCliCommand[],
  ): void {
    const name = String(command.name || '');
    assertPluginCommandName(pluginId, 'CLI command', name);
    if (!declared.some((entry) => entry.name === name)) {
      throw new Error(
        `Plugin "${pluginId}" CLI command "${name}" is not declared in the manifest's \`cliCommands\`.`,
      );
    }
    if (typeof command.run !== 'function') {
      throw new Error(`Plugin "${pluginId}" CLI command "${name}" has no run.`);
    }
    const existing = this.entries.get(name);
    if (existing) {
      throw new Error(
        `Plugin CLI command "${name}" is already registered by "${existing.pluginId}".`,
      );
    }
    this.entries.set(name, { pluginId, command: { ...command } });
  }

  find(name: string): RegisteredPluginCliCommand | undefined {
    return this.entries.get(name);
  }

  snapshot(): Map<string, RegisteredPluginCliCommand> {
    return new Map(this.entries);
  }

  restore(entries: Map<string, RegisteredPluginCliCommand>): void {
    this.entries = new Map(entries);
  }
}
