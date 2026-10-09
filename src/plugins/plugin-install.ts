/**
 * Plugin installation boundary — resolves sources, stages plugin trees, and
 * installs declared dependencies. Trust decisions stay with its callers.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getRuntimeConfig,
  type RuntimeConfig,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import { resolveInstallRoot } from '../infra/install-root.js';
import { readStoredRuntimeSecret } from '../security/runtime-secrets.js';
import { hasExecutableCommand } from '../utils/executables.js';
import { expandHomePath } from '../utils/path.js';
import { isPackagedPluginId } from './packaged-plugin-ids.js';
import {
  allRequiredBinsAvailable,
  checkPluginDependencies,
  defaultPluginDependencyCheckCommand,
  getPluginLocalBinDirs,
  hasInstallablePluginDependencies,
  installPluginDependencyPlan,
  type PluginDependencyCheckReport,
  type PluginDependencyCommandChecker,
  type PluginDependencyInstallSummary,
  type PluginDependencyPlan,
  planPluginDependencyInstall,
  resolveExecutableFromSearchDirs,
} from './plugin-dependencies.js';
import {
  loadPluginManifest,
  MANIFEST_FILE_NAME,
  PluginManager,
} from './plugin-manager.js';
import { fetchPluginDirFromNpmSpec } from './plugin-npm-fetch.js';
import type {
  PluginAvailableSummary,
  PluginBinaryRequirement,
  PluginManifest,
} from './plugin-types.js';

const PACKAGE_ROOT = resolveInstallRoot();

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

export function formatDependencyPlanDetails(plan: {
  usesPackageJson: boolean;
  nodePackages: string[];
  pipPackages: string[];
}): string {
  const parts: string[] = [];
  if (plan.usesPackageJson) {
    parts.push('npm install from package.json');
  }
  if (plan.nodePackages.length > 0) {
    parts.push(`npm packages: ${plan.nodePackages.join(', ')}`);
  }
  if (plan.pipPackages.length > 0) {
    parts.push(`pip packages: ${plan.pipPackages.join(', ')}`);
  }
  return parts.join('; ');
}

export interface InstallPluginOptions {
  homeDir?: string;
  cwd?: string;
  runCommand?: PluginInstallCommandRunner;
  runCheckCommand?: PluginDependencyCommandChecker;
  approveDependencyInstall?: boolean;
  onDependenciesAlreadySatisfied?: (plan: PluginDependencyPlan) => void;
  getRuntimeConfig?: PluginConfigGetter;
  updateRuntimeConfig?: PluginConfigUpdater;
}

export interface InstallPluginResult {
  pluginId: string;
  pluginDir: string;
  source: string;
  alreadyInstalled: boolean;
  // A bundled plugin enabled in place loads only through its plugins.list[]
  // entry; a home copy auto-discovers without one.
  enabledInPlace: boolean;
  dependenciesInstalled: boolean;
  dependencySummary: PluginDependencyInstallSummary;
  configuredRequiredBins: ConfiguredPluginBinaryRequirement[];
  externalDependencies: PluginDependencyCheckReport['externalDependencies'];
  requiresEnv: string[];
  requiredConfigKeys: string[];
  missingRequiredBins?: MissingPluginBinaryRequirement[];
}

export interface ReinstallPluginResult extends InstallPluginResult {
  replacedExistingInstall: boolean;
}

export interface MissingPluginBinaryRequirement {
  name: string;
  command: string;
  configKey?: string;
  installHint?: string;
  installUrl?: string;
}

export interface ConfiguredPluginBinaryRequirement {
  name: string;
  command: string;
  configKey: string;
}

export interface CheckPluginOptions {
  homeDir?: string;
  cwd?: string;
  getRuntimeConfig?: PluginConfigGetter;
  runCheckCommand?: PluginDependencyCommandChecker;
}

export interface CheckPluginResult {
  pluginId: string;
  pluginDir: string;
  source: 'home' | 'project' | 'bundled' | 'config';
  requiresEnv: string[];
  missingEnv: string[];
  requiredConfigKeys: string[];
  packageJsonDependencies: PluginDependencyCheckReport['packageJsonDependencies'];
  nodeDependencies: PluginDependencyCheckReport['nodeDependencies'];
  pipDependencies: PluginDependencyCheckReport['pipDependencies'];
  externalDependencies: PluginDependencyCheckReport['externalDependencies'];
  configuredRequiredBins: ConfiguredPluginBinaryRequirement[];
  missingRequiredBins?: MissingPluginBinaryRequirement[];
}

export class PluginDependencyApprovalRequiredError extends Error {
  readonly plan: PluginDependencyPlan;

  constructor(plan: PluginDependencyPlan) {
    super(buildDependencyApprovalMessage(plan));
    this.name = 'PluginDependencyApprovalRequiredError';
    this.plan = plan;
  }
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

function buildDependencyApprovalMessage(plan: PluginDependencyPlan): string {
  const details: string[] = [];
  if (plan.usesPackageJson) {
    details.push('npm install from package.json');
  }
  if (plan.nodePackages.length > 0) {
    details.push(`npm packages: ${plan.nodePackages.join(', ')}`);
  }
  if (plan.pipPackages.length > 0) {
    details.push(`pip packages: ${plan.pipPackages.join(', ')}`);
  }
  return [
    'Plugin dependency installation requires explicit approval.',
    details.length > 0 ? `Planned actions: ${details.join('; ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
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

function resolveProjectPluginDir(input: string, cwd: string): string | null {
  const installSource = String(input || '').trim();
  if (!installSource || looksLikeLocalPath(installSource)) {
    return null;
  }
  // A bare id names the package's bundled plugin first, so a `plugins/<id>`
  // under the current directory cannot turn the in-place install of a
  // bundled plugin into a copy of the cwd's version.
  const roots = listPluginCatalogRoots(cwd).sort(
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
      const packageJsonPath = path.join(candidate, 'package.json');
      if (
        !fs.existsSync(manifestPath) ||
        !fs.statSync(manifestPath).isFile() ||
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

function listPluginCatalogRoots(cwd: string): Array<{
  dir: string;
  source: PluginAvailableSummary['source'];
}> {
  const roots = [
    {
      dir: path.join(cwd, 'plugins'),
      source: 'project' as const,
    },
    {
      dir: path.join(PACKAGE_ROOT, 'plugins'),
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

export function listInstallablePlugins(options?: {
  cwd?: string;
}): PluginAvailableSummary[] {
  const cwd = options?.cwd || process.cwd();
  return listInstallablePluginsFromRoots(listPluginCatalogRoots(cwd));
}

export function listBundledInstallablePlugins(): PluginAvailableSummary[] {
  return listInstallablePluginsFromRoots([
    {
      dir: path.join(PACKAGE_ROOT, 'plugins'),
      source: 'bundled',
    },
  ]);
}

function listInstallablePluginsFromRoots(
  roots: Array<{
    dir: string;
    source: PluginAvailableSummary['source'];
  }>,
): PluginAvailableSummary[] {
  const discovered = new Map<string, PluginAvailableSummary>();
  for (const root of roots) {
    if (!fs.existsSync(root.dir)) continue;
    const entries = fs
      .readdirSync(root.dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const pluginDir = path.join(root.dir, entry.name);
      const manifestPath = path.join(pluginDir, MANIFEST_FILE_NAME);
      if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
        continue;
      }
      try {
        const manifest = loadPluginManifest(manifestPath);
        if (discovered.has(manifest.id)) continue;
        discovered.set(manifest.id, {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          source: root.source,
          dir: pluginDir,
          installSource: manifest.id,
        });
      } catch {}
    }
  }
  return [...discovered.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
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
  const bundledPluginDir = resolveProjectPluginDir(input, cwd);
  if (bundledPluginDir) {
    return {
      kind: 'local-dir',
      path: bundledPluginDir,
    };
  }
  if (looksLikeLocalPath(input)) {
    throw new Error(`Plugin path not found: ${input}`);
  }
  if (isPackagedPluginId(PACKAGE_ROOT, input)) {
    throw new Error(
      `Plugin ${input} ships with HybridClaw but is missing from this install (${path.join(PACKAGE_ROOT, 'plugins', input)}); it is never fetched from npm.`,
    );
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

function getRequiredConfigKeys(manifest: PluginManifest): string[] {
  const required = manifest.configSchema?.required;
  if (!Array.isArray(required)) return [];
  return required.filter(
    (entry): entry is string =>
      typeof entry === 'string' && entry.trim().length > 0,
  );
}

function getManifestConfigDefault(
  manifest: PluginManifest,
  key: string,
): string | undefined {
  const properties = manifest.configSchema?.properties;
  if (!properties || typeof properties !== 'object') return undefined;
  const schema = properties[key];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return undefined;
  }
  const value = schema.default;
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function findPluginConfigEntry(
  config: RuntimeConfig,
  pluginId: string,
): { id: string; enabled: boolean; config: Record<string, unknown> } | null {
  return (
    config.plugins.list.find(
      (entry) => String(entry?.id || '').trim() === pluginId,
    ) || null
  );
}

function ensurePluginConfigEntry(
  config: RuntimeConfig,
  pluginId: string,
): { id: string; enabled: boolean; config: Record<string, unknown> } {
  const existing = findPluginConfigEntry(config, pluginId);
  if (existing) {
    existing.config = existing.config || {};
    return existing;
  }
  const entry = {
    id: pluginId,
    enabled: true,
    config: {},
  };
  config.plugins.list.push(entry);
  return entry;
}

function resolveRequiredBinaryCommand(
  requirement: PluginBinaryRequirement,
  manifest: PluginManifest,
  config: Record<string, unknown>,
): string {
  if (requirement.configKey) {
    const configured = config[requirement.configKey];
    if (typeof configured === 'string' && configured.trim().length > 0) {
      return configured.trim();
    }
    const configuredDefault = getManifestConfigDefault(
      manifest,
      requirement.configKey,
    );
    if (configuredDefault) return configuredDefault;
  }
  return requirement.name;
}

function collectMissingRequiredBins(
  pluginId: string,
  manifest: PluginManifest,
  config: RuntimeConfig,
  cwd: string,
): MissingPluginBinaryRequirement[] {
  const pluginConfig = findPluginConfigEntry(config, pluginId)?.config || {};
  const missing: MissingPluginBinaryRequirement[] = [];
  for (const requirement of manifest.requires?.bins ?? []) {
    const command = resolveRequiredBinaryCommand(
      requirement,
      manifest,
      pluginConfig,
    );
    if (hasExecutableCommand(command, { cwd })) continue;
    missing.push({
      name: requirement.name,
      command,
      ...(requirement.configKey ? { configKey: requirement.configKey } : {}),
      ...(requirement.installHint
        ? { installHint: requirement.installHint }
        : {}),
      ...(requirement.installUrl ? { installUrl: requirement.installUrl } : {}),
    });
  }
  return missing;
}

function autoConfigurePluginLocalBinaries(params: {
  pluginId: string;
  pluginDir: string;
  manifest: PluginManifest;
  cwd: string;
  getRuntimeConfig: PluginConfigGetter;
  updateRuntimeConfig: PluginConfigUpdater;
}): ConfiguredPluginBinaryRequirement[] {
  const searchDirs = getPluginLocalBinDirs(params.pluginDir);
  if (searchDirs.length === 0) return [];

  const currentConfig = params.getRuntimeConfig();
  const currentPluginConfig =
    findPluginConfigEntry(currentConfig, params.pluginId)?.config || {};
  const resolved: ConfiguredPluginBinaryRequirement[] = [];

  for (const requirement of params.manifest.requires?.bins ?? []) {
    if (!requirement.configKey) continue;
    const currentCommand = resolveRequiredBinaryCommand(
      requirement,
      params.manifest,
      currentPluginConfig,
    );
    if (hasExecutableCommand(currentCommand, { cwd: params.cwd })) continue;
    const configuredValue = currentPluginConfig[requirement.configKey];
    if (
      typeof configuredValue === 'string' &&
      configuredValue.trim().length > 0
    ) {
      continue;
    }
    const command = resolveExecutableFromSearchDirs(
      requirement.name,
      searchDirs,
    );
    if (!command) continue;
    resolved.push({
      name: requirement.name,
      command,
      configKey: requirement.configKey,
    });
  }

  if (resolved.length === 0) return [];

  params.updateRuntimeConfig((draft) => {
    const entry = ensurePluginConfigEntry(draft, params.pluginId);
    for (const requirement of resolved) {
      entry.config[requirement.configKey] = requirement.command;
    }
  });
  return resolved;
}

function countPluginConfigOverrides(
  pluginId: string,
  config: RuntimeConfig,
): number {
  return config.plugins.list.filter(
    (entry) => String(entry?.id || '').trim() === pluginId,
  ).length;
}

function emptyDependencyInstallSummary(): PluginDependencyInstallSummary {
  return {
    usedPackageJson: false,
    installedNodePackages: [],
    installedPipPackages: [],
  };
}

function installPreparedPlugin(
  sourceDir: string,
  sourceLabel: string,
  options: {
    homeDir: string;
    cwd: string;
    runCommand: PluginInstallCommandRunner;
    runCheckCommand: PluginDependencyCommandChecker;
    approveDependencyInstall: boolean;
    onDependenciesAlreadySatisfied?: (plan: PluginDependencyPlan) => void;
    getRuntimeConfig: PluginConfigGetter;
    updateRuntimeConfig: PluginConfigUpdater;
    replaceExisting: boolean;
  },
): InstallPluginResult {
  const installRoot = path.join(options.homeDir, 'plugins');
  fs.mkdirSync(installRoot, { recursive: true });

  assertPluginManifestDir(sourceDir);
  const manifest = loadPluginManifest(path.join(sourceDir, MANIFEST_FILE_NAME));
  const dependencyPlan = planPluginDependencyInstall(sourceDir, manifest);
  // (#1893 review, 2026-10-08): a bundled plugin with nothing to install is
  // enabled in place, so it upgrades with the package instead of freezing as
  // a home copy against a newer plugin SDK. Plugins with deps still copy;
  // an SDK version range for third-party plugins is deferred.
  const homeCopyDir = path.join(installRoot, manifest.id);
  const bundledRoot = path.join(PACKAGE_ROOT, 'plugins');
  const bundled =
    fs.existsSync(bundledRoot) &&
    path.dirname(fs.realpathSync(sourceDir)) === fs.realpathSync(bundledRoot) &&
    !hasInstallablePluginDependencies(dependencyPlan);
  const pluginDir = bundled ? sourceDir : homeCopyDir;
  const wasEnabled =
    findPluginConfigEntry(options.getRuntimeConfig(), manifest.id)?.enabled ===
    true;
  if (bundled) {
    if (fs.existsSync(homeCopyDir) && !options.replaceExisting) {
      throw new Error(
        `Plugin "${manifest.id}" is already installed at ${homeCopyDir}. Run \`hybridclaw plugin reinstall ${manifest.id}\` to use the bundled copy that upgrades with HybridClaw.`,
      );
    }
    fs.rmSync(homeCopyDir, { recursive: true, force: true });
    options.updateRuntimeConfig((draft) => {
      ensurePluginConfigEntry(draft, manifest.id).enabled = true;
    });
  }
  let skipDependencyInstall = false;
  if (
    hasInstallablePluginDependencies(dependencyPlan) &&
    !options.approveDependencyInstall
  ) {
    if (allRequiredBinsAvailable(manifest, options.cwd)) {
      skipDependencyInstall = true;
      options.onDependenciesAlreadySatisfied?.(dependencyPlan);
    } else {
      throw new PluginDependencyApprovalRequiredError(dependencyPlan);
    }
  }
  const cleanupDirs: string[] = [];
  let backupDir: string | null = null;
  let installedPluginDir = false;

  try {
    if (fs.existsSync(pluginDir)) {
      if (options.replaceExisting && !bundled) {
        backupDir = path.join(
          installRoot,
          `.${manifest.id}.backup-${randomUUID().slice(0, 8)}`,
        );
        fs.renameSync(pluginDir, backupDir);
      } else {
        const sourceRealPath = fs.realpathSync(sourceDir);
        const pluginRealPath = fs.realpathSync(pluginDir);
        if (sourceRealPath !== pluginRealPath) {
          throw new Error(
            `Plugin "${manifest.id}" is already installed at ${pluginDir}.`,
          );
        }

        const pluginDependencyPlan = planPluginDependencyInstall(
          pluginDir,
          manifest,
        );
        const dependencySummary =
          !skipDependencyInstall &&
          hasInstallablePluginDependencies(pluginDependencyPlan)
            ? installPluginDependencyPlan(
                pluginDir,
                pluginDependencyPlan,
                options.runCommand,
                options.runCheckCommand,
              )
            : emptyDependencyInstallSummary();
        const configuredRequiredBins = autoConfigurePluginLocalBinaries({
          pluginId: manifest.id,
          pluginDir,
          manifest,
          cwd: options.cwd,
          getRuntimeConfig: options.getRuntimeConfig,
          updateRuntimeConfig: options.updateRuntimeConfig,
        });
        const dependencyReport = checkPluginDependencies(
          pluginDir,
          manifest,
          options.runCheckCommand,
          { cwd: options.cwd },
        );
        const missingRequiredBins = collectMissingRequiredBins(
          manifest.id,
          manifest,
          options.getRuntimeConfig(),
          options.cwd,
        );
        return {
          pluginId: manifest.id,
          pluginDir,
          source: sourceLabel,
          alreadyInstalled: !bundled || wasEnabled,
          enabledInPlace: bundled,
          dependenciesInstalled:
            dependencySummary.usedPackageJson ||
            dependencySummary.installedNodePackages.length > 0 ||
            dependencySummary.installedPipPackages.length > 0,
          dependencySummary,
          configuredRequiredBins,
          externalDependencies: dependencyReport.externalDependencies,
          requiresEnv: manifest.requires?.env ?? [],
          requiredConfigKeys: getRequiredConfigKeys(manifest),
          ...(missingRequiredBins.length > 0 ? { missingRequiredBins } : {}),
        };
      }
    }

    const stageDir = path.join(
      installRoot,
      `.${manifest.id}.install-${randomUUID().slice(0, 8)}`,
    );
    cleanupDirs.push(stageDir);
    copyPluginTree(sourceDir, stageDir);
    fs.renameSync(stageDir, pluginDir);
    cleanupDirs.splice(cleanupDirs.indexOf(stageDir), 1);
    installedPluginDir = true;
    const pluginDependencyPlan = planPluginDependencyInstall(
      pluginDir,
      manifest,
    );
    const dependencySummary =
      !skipDependencyInstall &&
      hasInstallablePluginDependencies(pluginDependencyPlan)
        ? installPluginDependencyPlan(
            pluginDir,
            pluginDependencyPlan,
            options.runCommand,
            options.runCheckCommand,
          )
        : emptyDependencyInstallSummary();
    const configuredRequiredBins = autoConfigurePluginLocalBinaries({
      pluginId: manifest.id,
      pluginDir,
      manifest,
      cwd: options.cwd,
      getRuntimeConfig: options.getRuntimeConfig,
      updateRuntimeConfig: options.updateRuntimeConfig,
    });
    const dependencyReport = checkPluginDependencies(
      pluginDir,
      manifest,
      options.runCheckCommand,
      { cwd: options.cwd },
    );
    const missingRequiredBins = collectMissingRequiredBins(
      manifest.id,
      manifest,
      options.getRuntimeConfig(),
      options.cwd,
    );

    return {
      pluginId: manifest.id,
      pluginDir,
      source: sourceLabel,
      alreadyInstalled: false,
      enabledInPlace: false,
      dependenciesInstalled:
        dependencySummary.usedPackageJson ||
        dependencySummary.installedNodePackages.length > 0 ||
        dependencySummary.installedPipPackages.length > 0,
      dependencySummary,
      configuredRequiredBins,
      externalDependencies: dependencyReport.externalDependencies,
      requiresEnv: manifest.requires?.env ?? [],
      requiredConfigKeys: getRequiredConfigKeys(manifest),
      ...(missingRequiredBins.length > 0 ? { missingRequiredBins } : {}),
    };
  } catch (error) {
    if (installedPluginDir && fs.existsSync(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true, force: true });
      installedPluginDir = false;
    }
    if (backupDir && fs.existsSync(backupDir)) {
      fs.renameSync(backupDir, pluginDir);
      backupDir = null;
    }
    throw error;
  } finally {
    if (backupDir && fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
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
      'Missing plugin source. Use `hybridclaw plugin install <path|plugin-id|npm-spec>`.',
    );
  }

  const homeDir = options.homeDir ?? DEFAULT_RUNTIME_HOME_DIR;
  const cwd = options.cwd ?? process.cwd();
  const runCommand = options.runCommand ?? defaultRunCommand;
  const runCheckCommand =
    options.runCheckCommand ?? defaultPluginDependencyCheckCommand;
  const getConfig = options.getRuntimeConfig ?? getRuntimeConfig;
  const updateConfig = options.updateRuntimeConfig ?? updateRuntimeConfig;
  const sourceRef = resolvePluginSource(trimmedSource, cwd);
  const preparedSource = preparePluginSource(sourceRef, runCommand);

  try {
    return installPreparedPlugin(preparedSource.sourceDir, trimmedSource, {
      homeDir,
      cwd,
      runCommand,
      runCheckCommand,
      approveDependencyInstall: options.approveDependencyInstall === true,
      onDependenciesAlreadySatisfied: options.onDependenciesAlreadySatisfied,
      getRuntimeConfig: getConfig,
      updateRuntimeConfig: updateConfig,
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
      'Missing plugin source. Use `hybridclaw plugin reinstall <path|plugin-id|npm-spec>`.',
    );
  }

  const homeDir = options.homeDir ?? DEFAULT_RUNTIME_HOME_DIR;
  const cwd = options.cwd ?? process.cwd();
  const runCommand = options.runCommand ?? defaultRunCommand;
  const runCheckCommand =
    options.runCheckCommand ?? defaultPluginDependencyCheckCommand;
  const getConfig = options.getRuntimeConfig ?? getRuntimeConfig;
  const updateConfig = options.updateRuntimeConfig ?? updateRuntimeConfig;
  const sourceRef = resolvePluginSource(trimmedSource, cwd);
  const preparedSource = preparePluginSource(sourceRef, runCommand);

  try {
    assertPluginManifestDir(preparedSource.sourceDir);
    const manifest = loadPluginManifest(
      path.join(preparedSource.sourceDir, MANIFEST_FILE_NAME),
    );
    const pluginDir = path.join(homeDir, 'plugins', manifest.id);
    const replacedExistingInstall = fs.existsSync(pluginDir);
    const result = installPreparedPlugin(
      preparedSource.sourceDir,
      trimmedSource,
      {
        homeDir,
        cwd,
        runCommand,
        runCheckCommand,
        approveDependencyInstall: options.approveDependencyInstall === true,
        onDependenciesAlreadySatisfied: options.onDependenciesAlreadySatisfied,
        getRuntimeConfig: getConfig,
        updateRuntimeConfig: updateConfig,
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

export async function checkPlugin(
  pluginIdInput: string,
  options: CheckPluginOptions = {},
): Promise<CheckPluginResult> {
  const pluginId = normalizePluginId(pluginIdInput);
  const homeDir = options.homeDir ?? DEFAULT_RUNTIME_HOME_DIR;
  const cwd = options.cwd ?? process.cwd();
  const getConfig = options.getRuntimeConfig ?? getRuntimeConfig;
  const runCheckCommand =
    options.runCheckCommand ?? defaultPluginDependencyCheckCommand;
  const config = getConfig();
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });
  const candidate = (await manager.discoverPlugins(config)).find(
    (entry) => entry.id === pluginId,
  );
  if (!candidate) {
    throw new Error(
      `Plugin "${pluginId}" was not found. Install or discover it before checking dependencies.`,
    );
  }

  const missingEnv = (candidate.manifest.requires?.env ?? []).filter((key) => {
    const envValue = process.env[key];
    if (typeof envValue === 'string' && envValue.trim().length > 0) {
      return false;
    }
    const stored = readStoredRuntimeSecret(key);
    return typeof stored !== 'string' || stored.trim().length === 0;
  });
  const dependencyReport = checkPluginDependencies(
    candidate.dir,
    candidate.manifest,
    runCheckCommand,
    { cwd },
  );
  const configuredRequiredBins = (candidate.manifest.requires?.bins ?? [])
    .map((requirement) => {
      if (!requirement.configKey) return null;
      const command = candidate.config[requirement.configKey];
      if (typeof command !== 'string' || command.trim().length === 0) {
        return null;
      }
      return {
        name: requirement.name,
        command: command.trim(),
        configKey: requirement.configKey,
      };
    })
    .filter(
      (entry): entry is ConfiguredPluginBinaryRequirement => entry !== null,
    );
  const missingRequiredBins = collectMissingRequiredBins(
    candidate.id,
    candidate.manifest,
    config,
    cwd,
  );

  return {
    pluginId: candidate.id,
    pluginDir: candidate.dir,
    source: candidate.source,
    requiresEnv: candidate.manifest.requires?.env ?? [],
    missingEnv,
    requiredConfigKeys: getRequiredConfigKeys(candidate.manifest),
    packageJsonDependencies: dependencyReport.packageJsonDependencies,
    nodeDependencies: dependencyReport.nodeDependencies,
    pipDependencies: dependencyReport.pipDependencies,
    externalDependencies: dependencyReport.externalDependencies,
    configuredRequiredBins,
    ...(missingRequiredBins.length > 0 ? { missingRequiredBins } : {}),
  };
}

export async function uninstallPlugin(
  pluginIdInput: string,
  options: UninstallPluginOptions = {},
): Promise<UninstallPluginResult> {
  const pluginId = normalizePluginId(pluginIdInput);
  const homeDir = options.homeDir ?? DEFAULT_RUNTIME_HOME_DIR;
  const getConfig = options.getRuntimeConfig ?? getRuntimeConfig;
  const updateConfig = options.updateRuntimeConfig ?? updateRuntimeConfig;
  const pluginsRoot = path.join(homeDir, 'plugins');
  const pluginDir = path.join(pluginsRoot, pluginId);

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
      `Plugin "${pluginId}" is not installed in ${pluginsRoot} and has no matching plugins.list[] override.`,
    );
  }

  return {
    pluginId,
    pluginDir,
    removedPluginDir,
    removedConfigOverrides,
  };
}
