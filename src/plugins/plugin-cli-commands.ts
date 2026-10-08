/**
 * Plugin CLI command table — one owner per top-level `hybridclaw <name>`.
 *
 * The CLI consults it only for a name no built-in command handles, so a
 * plugin can add commands but never replace one. A duplicate or malformed
 * name fails at registration. NOT the gateway slash-command table
 * (`registerCommand`); these run in the CLI process, not in a session.
 */
import type { PluginCliCommandDefinition } from './plugin-types.js';

const CLI_COMMAND_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

export interface RegisteredPluginCliCommand {
  pluginId: string;
  command: PluginCliCommandDefinition;
}

export class PluginCliCommandRegistry {
  private entries = new Map<string, RegisteredPluginCliCommand>();

  register(pluginId: string, command: PluginCliCommandDefinition): void {
    const name = String(command.name || '');
    if (!CLI_COMMAND_NAME_RE.test(name)) {
      throw new Error(
        `Plugin "${pluginId}" CLI command name "${name}" must be lowercase letters, digits, and dashes.`,
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
