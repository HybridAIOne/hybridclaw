/**
 * Plugin CLI command table — one owner per top-level `hybridclaw <name>`.
 *
 * The manifest's `cliCommands` is the source of truth: the CLI routes a name
 * to the one plugin whose manifest declares it and imports only that plugin,
 * and `register` rejects a command the manifest does not declare. The CLI
 * consults it only for a name no built-in command handles, so a plugin can
 * add commands but never replace one. NOT the gateway slash-command table
 * (`registerCommand`); these run in the CLI process, not in a session.
 */
import type {
  PluginCliCommandDefinition,
  PluginManifestCliCommand,
} from './plugin-types.js';

const CLI_COMMAND_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

function assertCliCommandName(owner: string, name: string): void {
  if (!CLI_COMMAND_NAME_RE.test(name)) {
    throw new Error(
      `Plugin "${owner}" CLI command name "${name}" must be lowercase letters, digits, and dashes.`,
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
    assertCliCommandName(pluginId, name);
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
    assertCliCommandName(pluginId, name);
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
