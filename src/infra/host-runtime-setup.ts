import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { resolveInstallRoot } from './install-root.js';

export interface HostRuntimeCommand {
  command: string;
  args: string[];
}

interface EnsureHostRuntimeReadyOptions {
  commandName?: string;
  required?: boolean;
  installRoot?: string;
}

export class HostRuntimeSetupError extends Error {
  readonly missingDependencies: string[];

  constructor(message: string, missingDependencies: string[] = []) {
    super(message);
    this.name = 'HostRuntimeSetupError';
    this.missingDependencies = missingDependencies;
  }
}

function readContainerDependencies(installRoot: string): string[] {
  const packageJsonPath = path.join(installRoot, 'container', 'package.json');
  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
    };
    return Object.keys(parsed.dependencies || {}).sort((left, right) =>
      left.localeCompare(right),
    );
  } catch {
    return [];
  }
}

function detectMissingContainerDependencies(installRoot: string): string[] {
  const containerPackageJsonPath = path.join(
    installRoot,
    'container',
    'package.json',
  );
  if (!fs.existsSync(containerPackageJsonPath)) return [];

  const resolveFromContainer = createRequire(containerPackageJsonPath);
  const containerNodeModulesDir = path.join(
    installRoot,
    'container',
    'node_modules',
  );
  const missing: string[] = [];
  for (const dependency of readContainerDependencies(installRoot)) {
    const dependencyPackageJsonPath = path.join(
      containerNodeModulesDir,
      ...dependency.split('/'),
      'package.json',
    );
    if (fs.existsSync(dependencyPackageJsonPath)) continue;

    try {
      resolveFromContainer.resolve(`${dependency}/package.json`);
    } catch {
      missing.push(dependency);
    }
  }
  return missing;
}

function isSourceCheckout(installRoot: string): boolean {
  return fs.existsSync(path.join(installRoot, '.git'));
}

function formatMissingDependencyMessage(
  commandName: string,
  installRoot: string,
  missingDependencies: string[],
): string {
  const noun = missingDependencies.length === 1 ? 'dependency' : 'dependencies';
  const list = missingDependencies.join(', ');
  const hint = isSourceCheckout(installRoot)
    ? 'If you are running from a source checkout, run `npm run setup` first.'
    : 'Reinstall HybridClaw.';
  return [
    `${commandName}: Host runtime is not ready.`,
    `Missing runtime ${noun}: ${list}.`,
    hint,
  ].join(' ');
}

export function resolveHostRuntimeCommand(
  installRoot = resolveInstallRoot(),
): HostRuntimeCommand {
  const builtEntrypoint = path.join(
    installRoot,
    'container',
    'dist',
    'index.js',
  );
  if (fs.existsSync(builtEntrypoint)) {
    return { command: process.execPath, args: [builtEntrypoint] };
  }

  const sourceEntrypoint = path.join(
    installRoot,
    'container',
    'src',
    'index.ts',
  );
  const tsxBin = path.join(
    installRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  );
  if (fs.existsSync(sourceEntrypoint) && fs.existsSync(tsxBin)) {
    return { command: tsxBin, args: [sourceEntrypoint] };
  }

  throw new HostRuntimeSetupError(
    'Host sandbox mode requires a local agent runtime. Run `npm --prefix container run build` or use the repo checkout with `tsx` installed.',
  );
}

export function ensureHostRuntimeReady(
  options: EnsureHostRuntimeReadyOptions = {},
): HostRuntimeCommand | null {
  const commandName = options.commandName || 'hybridclaw';
  const required = options.required !== false;
  const installRoot = options.installRoot || resolveInstallRoot();

  const runtime = resolveHostRuntimeCommand(installRoot);
  const missingDependencies = detectMissingContainerDependencies(installRoot);
  if (missingDependencies.length === 0) return runtime;

  const message = formatMissingDependencyMessage(
    commandName,
    installRoot,
    missingDependencies,
  );
  if (required) {
    throw new HostRuntimeSetupError(message, missingDependencies);
  }
  console.warn(message);
  return null;
}
