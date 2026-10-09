import { expect, test } from 'vitest';
import { PluginManager } from '../src/plugins/plugin-manager.js';
import type { PluginCommandDefinition } from '../src/plugins/plugin-types.js';

function register(adminAction: unknown) {
  const manager = new PluginManager({
    getRuntimeConfig: () => ({ plugins: { list: [] } }) as never,
  });
  manager.registerCommand('demo-plugin', {
    name: 'demo',
    description: 'demo',
    adminAction,
    handler: () => 'ok',
  } as unknown as PluginCommandDefinition);
}

test.each([
  { adminAction: undefined, error: null },
  { adminAction: 'admin.channels.write', error: null },
  { adminAction: 'admin.channel.write', error: 'unknown adminAction' },
  { adminAction: 42, error: 'unknown adminAction' },
])('a plugin command with adminAction $adminAction registers only when the action exists', ({
  adminAction,
  error,
}) => {
  if (error) {
    expect(() => register(adminAction)).toThrow(error);
  } else {
    expect(() => register(adminAction)).not.toThrow();
  }
});
