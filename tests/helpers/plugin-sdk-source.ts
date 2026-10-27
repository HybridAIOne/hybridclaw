/**
 * Lets a plugin that the real PluginManager imports with Node's own loader
 * (outside vitest's module graph) import `@hybridaione/hybridclaw/plugin-sdk`
 * values: the SDK link points at `src/plugins/plugin-sdk.ts`, which plain Node
 * cannot load. Tests that import plugin source directly mock the SDK instead.
 */
import { register } from 'tsx/esm/api';
import { afterAll } from 'vitest';

export function usePluginSdkSource(): void {
  const unregister = register();
  afterAll(() => unregister());
}
