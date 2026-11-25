/**
 * Plugin install-source classifier — decides whether an install argument maps
 * to a local tree, a local archive, a remote URL, or an explicit npm registry
 * spec. Bare ids never fall through to the npm registry: bundled and catalog
 * ids missing locally fail fast, and unknown bare ids require `npm:<pkg>`.
 *
 * NOT the installer or fetcher (`plugin-install.ts` stages trees and enforces
 * approval; `plugin-npm-fetch.ts` runs npm).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  getChannelPluginCatalogEntryByPluginId,
  getChannelPluginInstallCommand,
} from '../channels/channel-plugin-catalog.js';
import { expandHomePath } from '../utils/path.js';
import { isPackagedPluginId } from './packaged-plugin-ids.js';
import { loadPluginManifest, MANIFEST_FILE_NAME } from './plugin-manager.js';
import type { PluginAvailableSummary } from './plugin-types.js';

export type PluginSource =
  | {
      kind: 'local-dir';
      path: string;
    }
  | {
      kind: 'local-archive';
      spec: string;
    }
  | {
      kind: 'remote-url';
      spec: string;
    }
  | {
      kind: 'npm-registry';
      spec: string;
    };

export class PluginNpmInstallApprovalRequiredError extends Error {
  readonly spec: string;

  constructor(spec: string) {
    super(
      `Installing plugin "${spec}" from the npm registry requires explicit approval. Plugins run in-process in the gateway.`,
    );
    this.name = 'PluginNpmInstallApprovalRequiredError';
    this.spec = spec;
  }
}

export function isPluginNpmInstallApprovalRequiredError(
  error: unknown,
): error is PluginNpmInstallApprovalRequiredError {
  if (!(error instanceof Error)) return false;
  if (error.name !== 'PluginNpmInstallApprovalRequiredError') return false;
  const spec = (error as { spec?: unknown }).spec;
  return typeof spec === 'string' && spec.trim().length > 0;
}

const SCOPED_NPM_SPEC_RE =
  /^@[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?:@[A-Za-z0-9._^*~<>=|+-]+)?$/;
const UNSCOPED_NPM_SPEC_RE =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:@[A-Za-z0-9._^*~<>=|+-]+)?$/;
const REMOTE_PLUGIN_URL_RE =
  /^(?:https?:\/\/|git\+(?:https?|ssh):\/\/|git:\/\/|file:)\S+$/i;

function expandUserPath(input: string, cwd: string): string {
  return path.resolve(cwd, expandHomePath(input));
}

function looksLikeLocalPath(input: string): boolean {
  return (
    input.startsWith('.') ||
    input.startsWith('/') ||
    input.startsWith('~') ||
    /^[A-Za-z]:[\\/]/.test(input)
  );
}

function isScopedNpmPackageSpec(input: string): boolean {
  return SCOPED_NPM_SPEC_RE.test(input);
}

function isValidNpmPackageSpec(input: string): boolean {
  return SCOPED_NPM_SPEC_RE.test(input) || UNSCOPED_NPM_SPEC_RE.test(input);
}

function isRemotePluginUrl(input: string): boolean {
  return REMOTE_PLUGIN_URL_RE.test(input);
}

export function listPluginCatalogRoots(
  cwd: string,
  packageRoot: string,
): Array<{
  dir: string;
  source: PluginAvailableSummary['source'];
}> {
  const roots = [
    {
      dir: path.join(cwd, 'plugins'),
      source: 'project' as const,
    },
    {
      dir: path.join(packageRoot, 'plugins'),
      source: 'bundled' as const,
    },
  ];
  const seen = new Set<string>();
  return roots.filter((root) => {
    const resolved = path.resolve(root.dir);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

function resolveProjectPluginDir(
  input: string,
  cwd: string,
  packageRoot: string,
): string | null {
  const installSource = String(input || '').trim();
  if (
    !installSource ||
    looksLikeLocalPath(installSource) ||
    isRemotePluginUrl(installSource)
  ) {
    return null;
  }
  // A bare id names the package's bundled plugin first, so a `plugins/<id>`
  // under the current directory cannot turn the in-place install of a
  // bundled plugin into a copy of the cwd's version.
  const roots = listPluginCatalogRoots(cwd, packageRoot).sort(
    (left, right) =>
      Number(right.source === 'bundled') - Number(left.source === 'bundled'),
  );
  for (const root of roots) {
    const directCandidate = path.join(root.dir, installSource);
    if (
      fs.existsSync(directCandidate) &&
      fs.statSync(directCandidate).isDirectory() &&
      fs.existsSync(path.join(directCandidate, MANIFEST_FILE_NAME)) &&
      fs.statSync(path.join(directCandidate, MANIFEST_FILE_NAME)).isFile()
    ) {
      return directCandidate;
    }
    if (!fs.existsSync(root.dir) || !fs.statSync(root.dir).isDirectory()) {
      continue;
    }
    const entries = fs
      .readdirSync(root.dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const candidate = path.join(root.dir, entry.name);
      const manifestPath = path.join(candidate, MANIFEST_FILE_NAME);
      if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
        continue;
      }
      try {
        const manifest = loadPluginManifest(manifestPath);
        if (manifest.id === installSource) {
          return candidate;
        }
      } catch {}
      const packageJsonPath = path.join(candidate, 'package.json');
      if (
        !fs.existsSync(packageJsonPath) ||
        !fs.statSync(packageJsonPath).isFile()
      ) {
        continue;
      }
      try {
        const packageJson = JSON.parse(
          fs.readFileSync(packageJsonPath, 'utf-8'),
        ) as { name?: unknown };
        if (packageJson.name === installSource) {
          return candidate;
        }
      } catch {}
    }
  }
  return null;
}

export function resolvePluginSource(
  input: string,
  cwd: string,
  packageRoot: string,
): PluginSource {
  if (input.startsWith('npm:')) {
    const spec = input.slice('npm:'.length).trim();
    if (!spec) {
      throw new Error(
        'Missing npm package spec after "npm:". Use `hybridclaw plugin install npm:<package>`.',
      );
    }
    if (!isValidNpmPackageSpec(spec)) {
      throw new Error(
        `Invalid npm package spec "${spec}". Pass a package name such as \`npm:my-plugin\` or \`npm:@scope/my-plugin\`.`,
      );
    }
    return {
      kind: 'npm-registry',
      spec,
    };
  }

  const resolvedPath = expandUserPath(input, cwd);
  if (fs.existsSync(resolvedPath)) {
    const stats = fs.statSync(resolvedPath);
    if (stats.isDirectory()) {
      return {
        kind: 'local-dir',
        path: resolvedPath,
      };
    }
    return {
      kind: 'local-archive',
      spec: resolvedPath,
    };
  }

  const bundledPluginDir = resolveProjectPluginDir(input, cwd, packageRoot);
  if (bundledPluginDir) {
    return {
      kind: 'local-dir',
      path: bundledPluginDir,
    };
  }

  if (looksLikeLocalPath(input)) {
    throw new Error(`Plugin path not found: ${input}`);
  }

  if (isRemotePluginUrl(input)) {
    return {
      kind: 'remote-url',
      spec: input,
    };
  }

  if (isScopedNpmPackageSpec(input)) {
    return {
      kind: 'npm-registry',
      spec: input,
    };
  }

  if (isPackagedPluginId(packageRoot, input)) {
    throw new Error(
      `Bundled plugin "${input}" ships with HybridClaw but is not part of this install (${path.join(packageRoot, 'plugins', input)}); it is never fetched from npm.`,
    );
  }

  const channelEntry = getChannelPluginCatalogEntryByPluginId(input);
  if (channelEntry && channelEntry.installSource !== input) {
    throw new Error(
      `Plugin "${input}" is an externally hosted HybridClaw channel plugin and is never fetched from npm by bare id. Install it with \`hybridclaw plugin enable ${channelEntry.pluginId}\` or \`${getChannelPluginInstallCommand(channelEntry.channel)}\`.`,
    );
  }

  if (isValidNpmPackageSpec(input)) {
    throw new Error(
      `Plugin "${input}" was not found in bundled plugins or ./plugins/. Run \`hybridclaw plugin list available\` to see local plugins, or pass \`npm:<package>\` to install a package from npm.`,
    );
  }

  throw new Error(
    `Plugin "${input}" was not found locally and is not a valid plugin source. Pass a bundled plugin id, a local path, an archive URL, or \`npm:<package>\`.`,
  );
}
