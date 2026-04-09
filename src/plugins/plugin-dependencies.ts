import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  PluginExternalDependency,
  PluginManifest,
} from './plugin-types.js';

export interface PluginDependencyCommand {
  command: string;
  args: string[];
  cwd: string;
}

export interface PluginDependencyCheckCommand {
  command?: string;
  args?: string[];
  cwd: string;
  shellCommand?: string;
}

export interface PluginDependencyCheckCommandResult {
  ok: boolean;
  status: number | null;
  signal: string | null;
  error?: string;
}

export type PluginDependencyCommandRunner = (
  command: PluginDependencyCommand,
) => void;

export type PluginDependencyCommandChecker = (
  command: PluginDependencyCheckCommand,
) => PluginDependencyCheckCommandResult;

export interface PluginDependencyPlan {
  usesPackageJson: boolean;
  nodePackages: string[];
  pipPackages: string[];
  externalDependencies: PluginExternalDependency[];
}

export interface PluginDependencyInstallSummary {
  usedPackageJson: boolean;
  installedNodePackages: string[];
  installedPipPackages: string[];
}

export interface PluginPackageStatus {
  package: string;
  installed: boolean;
}

export interface PluginExternalDependencyStatus {
  name: string;
  check: string;
  installed: boolean;
  installHint?: string;
  installUrl?: string;
  error?: string;
}

export interface PluginDependencyCheckReport {
  packageJsonDependencies: PluginPackageStatus[];
  nodeDependencies: PluginPackageStatus[];
  pipDependencies: PluginPackageStatus[];
  externalDependencies: PluginExternalDependencyStatus[];
}

function normalizePackageSpec(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized ? normalized : null;
}

function extractCheckPackageName(spec: string): string {
  const trimmed = spec.trim();
  if (trimmed.startsWith('@')) {
    const match = /^(@[^/]+\/[^@<>=!~\s]+)(?:@.+)?$/u.exec(trimmed);
    if (match?.[1]) return match[1];
  }
  const match = /^([A-Za-z0-9_.-]+)/u.exec(trimmed);
  return match?.[1] || trimmed;
}

function collectLegacyManifestNodePackages(manifest: PluginManifest): string[] {
  return (manifest.install ?? [])
    .filter((entry) => entry.kind === 'npm' && entry.package)
    .map((entry) => entry.package as string);
}

function dedupePackages(packages: string[]): string[] {
  const unique = new Set<string>();
  for (const pkg of packages) {
    const normalized = normalizePackageSpec(pkg);
    if (!normalized) continue;
    unique.add(normalized);
  }
  return [...unique];
}

function getPluginVenvPythonPath(pluginDir: string): string {
  return process.platform === 'win32'
    ? path.join(pluginDir, '.venv', 'Scripts', 'python.exe')
    : path.join(pluginDir, '.venv', 'bin', 'python');
}

function hasUvAvailable(
  pluginDir: string,
  runCheckCommand: PluginDependencyCommandChecker,
): boolean {
  return runCheckCommand({
    command: 'uv',
    args: ['--version'],
    cwd: pluginDir,
  }).ok;
}

function ensurePluginPythonEnvironment(params: {
  pluginDir: string;
  runCommand: PluginDependencyCommandRunner;
  runCheckCommand: PluginDependencyCommandChecker;
}): string {
  const venvPython = getPluginVenvPythonPath(params.pluginDir);
  if (fs.existsSync(venvPython)) return venvPython;

  if (hasUvAvailable(params.pluginDir, params.runCheckCommand)) {
    params.runCommand({
      command: 'uv',
      args: ['venv', '--seed', '.venv'],
      cwd: params.pluginDir,
    });
    return venvPython;
  }

  params.runCommand({
    command: process.platform === 'win32' ? 'py' : 'python3',
    args: ['-m', 'venv', '.venv'],
    cwd: params.pluginDir,
  });
  params.runCommand({
    command: venvPython,
    args: ['-m', 'pip', 'install', '--upgrade', 'pip'],
    cwd: params.pluginDir,
  });
  return venvPython;
}

function readPackageJsonDependencies(pluginDir: string): string[] {
  const packageJsonPath = path.join(pluginDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
      dependencies?: Record<string, unknown>;
      optionalDependencies?: Record<string, unknown>;
    };
    return dedupePackages([
      ...Object.keys(parsed.dependencies || {}),
      ...Object.keys(parsed.optionalDependencies || {}),
    ]);
  } catch {
    return [];
  }
}

function isNodePackageInstalled(pluginDir: string, spec: string): boolean {
  const packageName = extractCheckPackageName(spec);
  const packageRoot = packageName.startsWith('@')
    ? path.join(
        pluginDir,
        'node_modules',
        packageName.split('/')[0] || '',
        packageName.split('/')[1] || '',
      )
    : path.join(pluginDir, 'node_modules', packageName);
  return fs.existsSync(packageRoot);
}

export function defaultPluginDependencyCheckCommand(
  command: PluginDependencyCheckCommand,
): PluginDependencyCheckCommandResult {
  const result = command.shellCommand
    ? spawnSync(command.shellCommand, {
        cwd: command.cwd,
        env: process.env,
        stdio: 'ignore',
        shell: true,
      })
    : spawnSync(command.command || '', command.args || [], {
        cwd: command.cwd,
        env: process.env,
        stdio: 'ignore',
      });
  return {
    ok:
      !result.error &&
      typeof result.status === 'number' &&
      result.status === 0 &&
      !result.signal,
    status: result.status ?? null,
    signal: result.signal ?? null,
    ...(result.error ? { error: result.error.message } : {}),
  };
}

export function getPluginLocalBinDirs(pluginDir: string): string[] {
  const dirs = [
    path.join(pluginDir, 'node_modules', '.bin'),
    process.platform === 'win32'
      ? path.join(pluginDir, '.venv', 'Scripts')
      : path.join(pluginDir, '.venv', 'bin'),
  ];
  return dirs.filter((dir) => fs.existsSync(dir));
}

export function resolveExecutableFromSearchDirs(
  command: string,
  searchDirs: string[],
): string | null {
  const normalized = String(command || '').trim();
  if (!normalized) return null;
  const exts =
    process.platform === 'win32'
      ? [
          '',
          ...(process.env.PATHEXT || '')
            .split(';')
            .map((ext) => ext.trim())
            .filter(Boolean),
        ]
      : [''];
  for (const dir of searchDirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${normalized}${ext}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // continue scanning
      }
    }
  }
  return null;
}

export function planPluginDependencyInstall(
  pluginDir: string,
  manifest: PluginManifest,
): PluginDependencyPlan {
  const usesPackageJson = fs.existsSync(path.join(pluginDir, 'package.json'));
  return {
    usesPackageJson,
    nodePackages: dedupePackages([
      ...(manifest.nodeDependencies ?? []).map((entry) => entry.package),
      ...(usesPackageJson ? [] : collectLegacyManifestNodePackages(manifest)),
    ]),
    pipPackages: dedupePackages(
      (manifest.pipDependencies ?? []).map((entry) => entry.package),
    ),
    externalDependencies: manifest.externalDependencies ?? [],
  };
}

export function hasInstallablePluginDependencies(
  plan: PluginDependencyPlan,
): boolean {
  return (
    plan.usesPackageJson ||
    plan.nodePackages.length > 0 ||
    plan.pipPackages.length > 0
  );
}

export function installPluginDependencyPlan(
  pluginDir: string,
  plan: PluginDependencyPlan,
  runCommand: PluginDependencyCommandRunner,
  runCheckCommand: PluginDependencyCommandChecker = defaultPluginDependencyCheckCommand,
): PluginDependencyInstallSummary {
  if (plan.usesPackageJson) {
    runCommand({
      command: 'npm',
      args: [
        'install',
        '--ignore-scripts',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
      ],
      cwd: pluginDir,
    });
  }

  if (plan.nodePackages.length > 0) {
    runCommand({
      command: 'npm',
      args: [
        'install',
        '--ignore-scripts',
        '--omit=dev',
        '--no-package-lock',
        '--no-audit',
        '--no-fund',
        ...plan.nodePackages,
      ],
      cwd: pluginDir,
    });
  }

  if (plan.pipPackages.length > 0) {
    const venvPython = ensurePluginPythonEnvironment({
      pluginDir,
      runCommand,
      runCheckCommand,
    });
    if (hasUvAvailable(pluginDir, runCheckCommand)) {
      runCommand({
        command: 'uv',
        args: ['pip', 'install', '--python', venvPython, ...plan.pipPackages],
        cwd: pluginDir,
      });
    } else {
      runCommand({
        command: venvPython,
        args: ['-m', 'pip', 'install', ...plan.pipPackages],
        cwd: pluginDir,
      });
    }
  }

  return {
    usedPackageJson: plan.usesPackageJson,
    installedNodePackages: [...plan.nodePackages],
    installedPipPackages: [...plan.pipPackages],
  };
}

export function checkPluginDependencies(
  pluginDir: string,
  manifest: PluginManifest,
  runCheckCommand: PluginDependencyCommandChecker = defaultPluginDependencyCheckCommand,
): PluginDependencyCheckReport {
  const hasPackageJson = fs.existsSync(path.join(pluginDir, 'package.json'));
  const packageJsonDependencies = readPackageJsonDependencies(pluginDir).map(
    (pkg) => ({
      package: pkg,
      installed: isNodePackageInstalled(pluginDir, pkg),
    }),
  );

  const nodeDependencies = dedupePackages([
    ...(manifest.nodeDependencies ?? []).map((entry) => entry.package),
    ...(hasPackageJson ? [] : collectLegacyManifestNodePackages(manifest)),
  ]).map((pkg) => ({
    package: pkg,
    installed: isNodePackageInstalled(pluginDir, pkg),
  }));

  const venvPython = getPluginVenvPythonPath(pluginDir);
  const pipDependencies = dedupePackages(
    (manifest.pipDependencies ?? []).map((entry) => entry.package),
  ).map((pkg) => ({
    package: pkg,
    installed:
      fs.existsSync(venvPython) &&
      runCheckCommand({
        command: venvPython,
        args: ['-m', 'pip', 'show', extractCheckPackageName(pkg)],
        cwd: pluginDir,
      }).ok,
  }));

  const externalDependencies = (manifest.externalDependencies ?? []).map(
    (dependency) => {
      const result = runCheckCommand({
        cwd: pluginDir,
        shellCommand: dependency.check,
      });
      return {
        name: dependency.name,
        check: dependency.check,
        installed: result.ok,
        ...(dependency.installHint
          ? { installHint: dependency.installHint }
          : {}),
        ...(dependency.installUrl ? { installUrl: dependency.installUrl } : {}),
        ...(!result.ok && result.error ? { error: result.error } : {}),
      };
    },
  );

  return {
    packageJsonDependencies,
    nodeDependencies,
    pipDependencies,
    externalDependencies,
  };
}
