/**
 * Runtime link from a plugin import snapshot to the gateway's own plugin SDK.
 *
 * Plugins import `@hybridaione/hybridclaw/plugin-sdk` for values such as
 * `WebhookHttpError`, but their snapshot's `node_modules` only holds the
 * plugin's own dependencies. This writes a one-subpath package next to the
 * snapshot that re-exports the SDK module this gateway loaded, from `dist` or
 * from source under tsx, so a plugin shares the gateway's module instances
 * (`instanceof WebhookHttpError` holds). It exposes nothing but the SDK.
 * NOT the snapshot copy itself (`createPluginImportSnapshot`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PLUGIN_SDK_PACKAGE = '@hybridaione/hybridclaw';

function resolvePluginSdkEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const name of ['plugin-sdk.js', 'plugin-sdk.ts']) {
    const candidate = path.join(here, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Plugin SDK module not found next to ${here}.`);
}

/** Makes the SDK resolvable for code under `rootDir` via Node's upward lookup. */
export function linkPluginSdk(rootDir: string): void {
  const packageDir = path.join(rootDir, 'node_modules', PLUGIN_SDK_PACKAGE);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: PLUGIN_SDK_PACKAGE,
      type: 'module',
      exports: { './plugin-sdk': './plugin-sdk.js' },
    }),
  );
  fs.writeFileSync(
    path.join(packageDir, 'plugin-sdk.js'),
    `export * from ${JSON.stringify(pathToFileURL(resolvePluginSdkEntry()).href)};\n`,
  );
}
