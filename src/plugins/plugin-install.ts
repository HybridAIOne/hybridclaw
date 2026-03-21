import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_RUNTIME_HOME_DIR,
  getRuntimeConfig,
  type RuntimeConfig,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import { loadPluginManifest } from './plugin-manager.js';
import type { PluginManifest } from './plugin-types.js';

const MANIFEST_FILE_NAME = 'hybridclaw.plugin.yaml';

interface PluginCommand {
  command: string;
  args: string[];
  cwd: string;
}

type PluginSource =
  | {
      kind: 'local-dir';
      path: string;
    }
  | {
      kind: 'npm-spec';
      spec: string;
    };

export type PluginInstallCommandRunner = (command: PluginCommand) => void;

export interface InstallPluginOptions {
  homeDir?: string;
  cwd?: string;
  runCommand?: PluginInstallCommandRunner;
}

export interface InstallPluginResult {
  pluginId: string;
  pluginDir: string;
  source: string;
  alreadyInstalled: boolean;
  dependenciesInstalled: boolean;
  requiresEnv: string[];
  requiredConfigKeys: string[];
}

export interface ReinstallPluginResult extends InstallPluginResult {
  replacedExistingInstall: boolean;
}

type PluginConfigGetter = () => RuntimeConfig;
type PluginConfigUpdater = (
  mutator: (draft: RuntimeConfig) => void,
) => RuntimeConfig;

export interface UninstallPluginOptions {
  homeDir?: string;
  getRuntimeConfig?: PluginConfigGetter;
  updateRuntimeConfig?: PluginConfigUpdater;
}

export interface UninstallPluginResult {
  pluginId: string;
  pluginDir: string;
  removedPluginDir: boolean;
  removedConfigOverrides: number;
}

function defaultRunCommand({ command, args, cwd }: PluginCommand): void {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status}.`,
    );
  }
  if (result.signal) {
    throw new Error(
      `${command} ${args.join(' ')} terminated by ${result.signal}.`,
    );
  }
}

function expandUserPath(input: string, cwd: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return path.resolve(cwd, input);
}

function looksLikeLocalPath(input: string): boolean {
  return (
    input.startsWith('.') ||
    input.startsWith('/') ||
    input.startsWith('~') ||
    /^[A-Za-z]:[\\/]/.test(input)
  );
}

function resolvePluginSource(input: string, cwd: string): PluginSource {
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
      kind: 'npm-spec',
      spec: resolvedPath,
    };
  }
  if (looksLikeLocalPath(input)) {
    throw new Error(`Plugin path not found: ${input}`);
  }
  return {
    kind: 'npm-spec',
    spec: input,
  };
}

function normalizePluginId(input: string): string {
  const pluginId = String(input || '').trim();
  if (!pluginId) {
    throw new Error(
      'Missing plugin id. Use `hybridclaw plugin uninstall <plugin-id>`.',
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pluginId)) {
    throw new Error(
      `Invalid plugin id "${pluginId}". Plugin ids may only contain letters, numbers, ".", "_" and "-".`,
    );
  }
  return pluginId;
}

function assertPluginManifestDir(dir: string): void {
  const manifestPath = path.join(dir, MANIFEST_FILE_NAME);
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
    throw new Error(
      `Plugin source at ${dir} is missing ${MANIFEST_FILE_NAME}.`,
    );
  }
}

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

function fetchPluginDirFromNpmSpec(
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

function preparePluginSource(
  sourceRef: PluginSource,
  runCommand: PluginInstallCommandRunner,
): { sourceDir: string; cleanupDirs: string[] } {
  if (sourceRef.kind === 'local-dir') {
    return {
      sourceDir: sourceRef.path,
      cleanupDirs: [],
    };
  }

  const fetchRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-plugin-fetch-'),
  );
  return {
    sourceDir: fetchPluginDirFromNpmSpec(sourceRef.spec, fetchRoot, runCommand),
    cleanupDirs: [fetchRoot],
  };
}

function copyPluginTree(sourceDir: string, targetDir: string): void {
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      if (src === sourceDir) return true;
      const base = path.basename(src);
      return base !== '.git' && base !== 'node_modules';
    },
  });
}

function collectManifestNpmPackages(manifest: PluginManifest): string[] {
  return (manifest.install ?? [])
    .filter((entry) => entry.kind === 'npm' && entry.package)
    .map((entry) => entry.package as string);
}

function installPluginDependencies(
  pluginDir: string,
  manifest: PluginManifest,
  runCommand: PluginInstallCommandRunner,
): boolean {
  const packageJsonPath = path.join(pluginDir, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
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
    return true;
  }

  const manifestPackages = collectManifestNpmPackages(manifest);
  if (manifestPackages.length === 0) return false;

  runCommand({
    command: 'npm',
    args: [
      'install',
      '--ignore-scripts',
      '--omit=dev',
      '--no-package-lock',
      '--no-audit',
      '--no-fund',
      ...manifestPackages,
    ],
    cwd: pluginDir,
  });
  return true;
}

function getRequiredConfigKeys(manifest: PluginManifest): string[] {
  const required = manifest.configSchema?.required;
  if (!Array.isArray(required)) return [];
  return required.filter(
    (entry): entry is string =>
      typeof entry === 'string' && entry.trim().length > 0,
  );
}

function countPluginConfigOverrides(
  pluginId: string,
  config: RuntimeConfig,
): number {
  return config.plugins.list.filter(
    (entry) => String(entry?.id || '').trim() === pluginId,
  ).length;
}

function installPreparedPlugin(
  sourceDir: string,
  sourceLabel: string,
  options: {
    homeDir: string;
    runCommand: PluginInstallCommandRunner;
    replaceExisting: boolean;
  },
): InstallPluginResult {
  const installRoot = path.join(DEFAULT_RUNTIME_HOME_DIR, 'plugins');
  fs.mkdirSync(installRoot, { recursive: true });

  assertPluginManifestDir(sourceDir);
  const manifest = loadPluginManifest(path.join(sourceDir, MANIFEST_FILE_NAME));
  const pluginDir = path.join(installRoot, manifest.id);
  const cleanupDirs: string[] = [];

  try {
    if (fs.existsSync(pluginDir)) {
      if (options.replaceExisting) {
        fs.rmSync(pluginDir, { recursive: true, force: true });
      } else {
        const sourceRealPath = fs.realpathSync(sourceDir);
        const pluginRealPath = fs.realpathSync(pluginDir);
        if (sourceRealPath !== pluginRealPath) {
          throw new Error(
            `Plugin "${manifest.id}" is already installed at ${pluginDir}.`,
          );
        }

        const dependenciesInstalled = installPluginDependencies(
          pluginDir,
          manifest,
          options.runCommand,
        );
        return {
          pluginId: manifest.id,
          pluginDir,
          source: sourceLabel,
          alreadyInstalled: true,
          dependenciesInstalled,
          requiresEnv: manifest.requires?.env ?? [],
          requiredConfigKeys: getRequiredConfigKeys(manifest),
        };
      }
    }

    const stageDir = path.join(
      installRoot,
      `.${manifest.id}.install-${randomUUID().slice(0, 8)}`,
    );
    cleanupDirs.push(stageDir);
    copyPluginTree(sourceDir, stageDir);
    const dependenciesInstalled = installPluginDependencies(
      stageDir,
      manifest,
      options.runCommand,
    );
    fs.renameSync(stageDir, pluginDir);
    cleanupDirs.splice(cleanupDirs.indexOf(stageDir), 1);

    return {
      pluginId: manifest.id,
      pluginDir,
      source: sourceLabel,
      alreadyInstalled: false,
      dependenciesInstalled,
      requiresEnv: manifest.requires?.env ?? [],
      requiredConfigKeys: getRequiredConfigKeys(manifest),
    };
  } finally {
    for (const dir of cleanupDirs.reverse()) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

export async function installPlugin(
  source: string,
  options: InstallPluginOptions = {},
): Promise<InstallPluginResult> {
  const trimmedSource = String(source || '').trim();
  if (!trimmedSource) {
    throw new Error(
      'Missing plugin source. Use `hybridclaw plugin install <path|npm-spec>`.',
    );
  }

  const homeDir = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const runCommand = options.runCommand ?? defaultRunCommand;
  const sourceRef = resolvePluginSource(trimmedSource, cwd);
  const preparedSource = preparePluginSource(sourceRef, runCommand);

  try {
    return installPreparedPlugin(preparedSource.sourceDir, trimmedSource, {
      homeDir,
      runCommand,
      replaceExisting: false,
    });
  } finally {
    for (const dir of preparedSource.cleanupDirs.reverse()) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

export async function reinstallPlugin(
  source: string,
  options: InstallPluginOptions = {},
): Promise<ReinstallPluginResult> {
  const trimmedSource = String(source || '').trim();
  if (!trimmedSource) {
    throw new Error(
      'Missing plugin source. Use `hybridclaw plugin reinstall <path|npm-spec>`.',
    );
  }

  const homeDir = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const runCommand = options.runCommand ?? defaultRunCommand;
  const sourceRef = resolvePluginSource(trimmedSource, cwd);
  const preparedSource = preparePluginSource(sourceRef, runCommand);

  try {
    assertPluginManifestDir(preparedSource.sourceDir);
    const manifest = loadPluginManifest(
      path.join(preparedSource.sourceDir, MANIFEST_FILE_NAME),
    );
    const pluginDir = path.join(DEFAULT_RUNTIME_HOME_DIR, 'plugins', manifest.id);
    const replacedExistingInstall = fs.existsSync(pluginDir);
    const result = installPreparedPlugin(
      preparedSource.sourceDir,
      trimmedSource,
      {
        homeDir,
        runCommand,
        replaceExisting: true,
      },
    );
    return {
      ...result,
      replacedExistingInstall,
      alreadyInstalled: false,
    };
  } finally {
    for (const dir of preparedSource.cleanupDirs.reverse()) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

export async function uninstallPlugin(
  pluginIdInput: string,
  options: UninstallPluginOptions = {},
): Promise<UninstallPluginResult> {
  const pluginId = normalizePluginId(pluginIdInput);
  const homeDir = options.homeDir ?? os.homedir();
  const getConfig = options.getRuntimeConfig ?? getRuntimeConfig;
  const updateConfig = options.updateRuntimeConfig ?? updateRuntimeConfig;
  const pluginDir = path.join(DEFAULT_RUNTIME_HOME_DIR, 'plugins', pluginId);

  const removedPluginDir = fs.existsSync(pluginDir);
  if (removedPluginDir) {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }

  const removedConfigOverrides = countPluginConfigOverrides(
    pluginId,
    getConfig(),
  );
  if (removedConfigOverrides > 0) {
    updateConfig((draft) => {
      draft.plugins.list = draft.plugins.list.filter(
        (entry) => String(entry?.id || '').trim() !== pluginId,
      );
    });
  }

  if (!removedPluginDir && removedConfigOverrides === 0) {
    throw new Error(
      `Plugin "${pluginId}" is not installed in ${path.join(DEFAULT_RUNTIME_HOME_DIR, 'plugins')} and has no matching plugins.list[] override.`,
    );
  }

  return {
    pluginId,
    pluginDir,
    removedPluginDir,
    removedConfigOverrides,
  };
}
