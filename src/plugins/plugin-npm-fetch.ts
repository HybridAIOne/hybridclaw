/**
 * Fetches a plugin published on npm into a scratch directory and locates its
 * manifest there. The caller owns the directory and stages the tree from it;
 * this module never installs into the runtime home. Exactly one top-level
 * package may carry a manifest, or the fetch is ambiguous and fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PluginInstallCommandRunner } from './plugin-install.js';
import { MANIFEST_FILE_NAME } from './plugin-manager.js';

function collectTopLevelNodeModuleDirs(nodeModulesRoot: string): string[] {
  if (!fs.existsSync(nodeModulesRoot)) return [];
  const dirs: string[] = [];
  for (const entry of fs.readdirSync(nodeModulesRoot, {
    withFileTypes: true,
  })) {
    if (entry.name === '.bin') continue;
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      const scopeRoot = path.join(nodeModulesRoot, entry.name);
      for (const scoped of fs.readdirSync(scopeRoot, { withFileTypes: true })) {
        if (!scoped.isDirectory()) continue;
        dirs.push(path.join(scopeRoot, scoped.name));
      }
      continue;
    }
    if (entry.isDirectory()) {
      dirs.push(path.join(nodeModulesRoot, entry.name));
    }
  }
  return dirs;
}

function findInstalledPluginDir(nodeModulesRoot: string): string {
  const candidates = collectTopLevelNodeModuleDirs(nodeModulesRoot).filter(
    (dir) => fs.existsSync(path.join(dir, MANIFEST_FILE_NAME)),
  );
  if (candidates.length === 1) {
    const [candidate] = candidates;
    if (candidate) return candidate;
  }
  if (candidates.length === 0) {
    throw new Error(
      `Installed npm package does not contain ${MANIFEST_FILE_NAME}.`,
    );
  }
  throw new Error(
    `Multiple plugin manifests were found in ${nodeModulesRoot}; installation is ambiguous.`,
  );
}

export function fetchPluginDirFromNpmSpec(
  spec: string,
  tempRoot: string,
  runCommand: PluginInstallCommandRunner,
): string {
  fs.mkdirSync(tempRoot, { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    `${JSON.stringify({ name: 'hybridclaw-plugin-install', private: true }, null, 2)}\n`,
    'utf-8',
  );
  runCommand({
    command: 'npm',
    args: [
      'install',
      '--ignore-scripts',
      '--no-package-lock',
      '--no-audit',
      '--no-fund',
      spec,
    ],
    cwd: tempRoot,
  });
  return findInstalledPluginDir(path.join(tempRoot, 'node_modules'));
}
