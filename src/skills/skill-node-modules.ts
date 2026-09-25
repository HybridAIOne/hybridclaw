/**
 * Skill module eligibility follows the agent runtime, not the gateway process.
 * Host agents use the gateway installation; container agents use dependencies
 * declared by the packaged agent image. This does not inspect a running image.
 */
import fs from 'node:fs';
import type { ContainerSandboxMode } from '../config/runtime-config.js';
import { resolveInstallPath } from '../infra/install-root.js';
import { hasResolvableNodeModule } from '../utils/node-modules.js';

const AGENT_PACKAGE_MANIFESTS = [
  '../../container/package.json',
  '../../container/tools/package.json',
] as const;

function agentPackageNames(): Set<string> {
  const names = new Set<string>();
  for (const relativePath of AGENT_PACKAGE_MANIFESTS) {
    const manifest = JSON.parse(
      fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      names.add(name);
    }
  }
  return names;
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
    return hasResolvableNodeModule(specifier, { cwd: resolveInstallPath() });
  }
  const packageName = packageNameOf(specifier);
  if (packageName === null) return false;
  containerPackages ??= agentPackageNames();
  return containerPackages.has(packageName);
}
