/**
 * Skill module eligibility follows the agent runtime, not the gateway process.
 * Host agents resolve from the gateway installation, the agent runtime's own
 * dependencies (container/), and the host copy of the shared skill libraries
 * (container/tools) that `skill setup` installs, while its lockfile matches
 * the packaged one; the host runner exports the last two as NODE_PATH, as the
 * images do. Container agents use the dependencies declared by the packaged
 * agent image. This does not inspect a running image.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ContainerSandboxMode } from '../config/runtime-config.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import { resolveInstallPath } from '../infra/install-root.js';
import { hasResolvableNodeModule } from '../utils/node-modules.js';

const SHARED_SKILL_LIBRARIES_MANIFEST = [
  'container',
  'tools',
  'package.json',
] as const;
const AGENT_PACKAGE_MANIFESTS = [
  ['container', 'package.json'],
  SHARED_SKILL_LIBRARIES_MANIFEST,
] as const;

function manifestDependencyNames(segments: readonly string[]): string[] {
  const manifest = JSON.parse(
    fs.readFileSync(resolveInstallPath(...segments), 'utf8'),
  ) as { dependencies?: Record<string, string> };
  return Object.keys(manifest.dependencies ?? {});
}

/** The libraries container/tools locks; throws when the install lacks it. */
export function sharedSkillLibraryNames(): string[] {
  return manifestDependencyNames(SHARED_SKILL_LIBRARIES_MANIFEST);
}

export function hostRuntimeToolsDir(): string {
  return path.join(DEFAULT_RUNTIME_HOME_DIR, 'runtime-tools');
}

// A data-dir copy staged from another release's lockfile is ignored, so host
// agents never keep loading libraries a later lockfile replaced (for example
// for a CVE); `skill list` then reports them missing until setup runs again.
export function hostRuntimeToolsStale(): boolean {
  let staged: Buffer;
  try {
    staged = fs.readFileSync(
      path.join(hostRuntimeToolsDir(), 'package-lock.json'),
    );
  } catch {
    return false;
  }
  try {
    return !staged.equals(
      fs.readFileSync(
        resolveInstallPath('container', 'tools', 'package-lock.json'),
      ),
    );
  } catch {
    return true;
  }
}

function hostAgentPackageDirs(): string[] {
  const dirs = [resolveInstallPath('container')];
  if (!hostRuntimeToolsStale()) dirs.push(hostRuntimeToolsDir());
  return dirs;
}

export function hostAgentNodePath(inherited?: string): string {
  return [
    ...hostAgentPackageDirs().map((dir) => path.join(dir, 'node_modules')),
    inherited,
  ]
    .filter(Boolean)
    .join(path.delimiter);
}

function agentPackageNames(): Set<string> {
  return new Set(AGENT_PACKAGE_MANIFESTS.flatMap(manifestDependencyNames));
}

let containerPackages: Set<string> | null = null;

function packageNameOf(specifier: string): string | null {
  const parts = specifier.trim().split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    return null;
  }
  if (specifier.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return parts[0];
}

export function hasAgentNodeModule(
  specifier: string,
  sandboxMode: ContainerSandboxMode,
): boolean {
  if (sandboxMode === 'host') {
    return [resolveInstallPath(), ...hostAgentPackageDirs()].some((cwd) =>
      hasResolvableNodeModule(specifier, { cwd }),
    );
  }
  const packageName = packageNameOf(specifier);
  if (packageName === null) return false;
  containerPackages ??= agentPackageNames();
  return containerPackages.has(packageName);
}
