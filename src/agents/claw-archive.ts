import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yazl from 'yazl';
import {
  getRuntimeConfig,
  type RuntimeConfig,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import {
  type InstallPluginResult,
  installPlugin,
  type PluginInstallCommandRunner,
} from '../plugins/plugin-install.js';
import {
  loadPluginManifest,
  validatePluginConfig,
} from '../plugins/plugin-manager.js';
import type { PluginManifest } from '../plugins/plugin-types.js';
import { normalizeTrimmedString as normalizeString } from '../utils/normalized-strings.js';
import { ensureBootstrapFiles } from '../workspace.js';
import {
  deleteRegisteredAgent,
  getAgentById,
  resolveAgentConfig,
  upsertRegisteredAgent,
} from './agent-registry.js';
import { DEFAULT_AGENT_ID } from './agent-types.js';
import {
  CLAW_FORMAT_VERSION,
  type ClawManifest,
  type ClawPluginExternalRef,
  type ClawSkillExternalRef,
  sanitizeClawAgentId,
  validateClawManifest,
} from './claw-manifest.js';
import { safeExtractZip, scanClawArchive } from './claw-security.js';

const MANIFEST_FILE_NAME = 'manifest.json';
const SKILL_MANIFEST_FILE = 'SKILL.md';
const PLUGIN_MANIFEST_FILE = 'hybridclaw.plugin.yaml';

interface ArchivedFile {
  absolutePath: string;
  relativePath: string;
}

interface PackSkillCandidate {
  directoryName: string;
  sourceDir: string;
}

interface PackPluginCandidate {
  pluginId: string;
  sourceDir: string;
  packageName: string | null;
  manifest: PluginManifest;
}

export type PackSelectionMode = 'ask' | 'active' | 'all' | 'some';

interface PluginInstallRollbackState {
  pluginDir: string;
  backupDir: string | null;
}

export type ClawPackSelection =
  | { mode: 'bundle' }
  | { mode: 'skip' }
  | {
      mode: 'external';
      reference: ClawSkillExternalRef | ClawPluginExternalRef;
    };

export type ClawPackPromptInput =
  | {
      kind: 'skill';
      directoryName: string;
      sourceDir: string;
    }
  | {
      kind: 'plugin';
      pluginId: string;
      sourceDir: string;
      packageName: string | null;
    };

export interface PackAgentOptions {
  outputPath?: string;
  cwd?: string;
  homeDir?: string;
  createdAt?: string;
  dryRun?: boolean;
  skillSelection?: {
    mode: PackSelectionMode;
    names?: string[];
  };
  pluginSelection?: {
    mode: PackSelectionMode;
    names?: string[];
  };
  manifestMetadata?: {
    description?: string;
    author?: string;
    version?: string;
  };
  promptSelection?: (
    input: ClawPackPromptInput,
  ) => Promise<ClawPackSelection> | ClawPackSelection;
}

export interface PackAgentResult {
  archivePath: string;
  manifest: ClawManifest;
  workspacePath: string;
  bundledSkills: string[];
  bundledPlugins: string[];
  externalSkills: ClawSkillExternalRef[];
  externalPlugins: ClawPluginExternalRef[];
  archiveEntries: string[];
}

export interface ClawArchiveInspection {
  archivePath: string;
  manifest: ClawManifest;
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
  entryNames: string[];
}

export interface UnpackAgentOptions {
  agentId?: string;
  force?: boolean;
  yes?: boolean;
  skipExternals?: boolean;
  cwd?: string;
  homeDir?: string;
  tempRoot?: string;
  runCommand?: PluginInstallCommandRunner;
  confirm?: (inspection: ClawArchiveInspection) => Promise<boolean> | boolean;
}

export interface UnpackAgentResult {
  archivePath: string;
  manifest: ClawManifest;
  agentId: string;
  workspacePath: string;
  bundledSkills: string[];
  installedPlugins: InstallPluginResult[];
  externalActions: string[];
  runtimeConfigChanged: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeArchiveFileStem(value: string): string {
  return (
    normalizeString(value)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'agent'
  );
}

const ARCHIVE_EXCLUDED_DIRECTORY_NAMES = new Set([
  '.git',
  '.hybridclaw-runtime',
  '.session-transcripts',
  'node_modules',
]);
const ARCHIVE_EXCLUDED_BASENAMES = new Set(['.DS_Store', 'Thumbs.db']);

function isPortableArchiveEnvFile(name: string): boolean {
  return name === '.env' || name.startsWith('.env.');
}

function shouldExcludePortableArchivePath(relativePath: string): boolean {
  const segments = relativePath
    .split(path.sep)
    .join('/')
    .split('/')
    .filter(Boolean);
  if (segments.length === 0) return false;
  if (
    segments.some((segment) => ARCHIVE_EXCLUDED_DIRECTORY_NAMES.has(segment))
  ) {
    return true;
  }
  const basename = segments[segments.length - 1];
  return (
    ARCHIVE_EXCLUDED_BASENAMES.has(basename) ||
    isPortableArchiveEnvFile(basename)
  );
}

function shouldExcludeWorkspaceArchivePath(relativePath: string): boolean {
  if (shouldExcludePortableArchivePath(relativePath)) {
    return true;
  }
  const segments = relativePath
    .split(path.sep)
    .join('/')
    .split('/')
    .filter(Boolean);
  if (segments.length === 0) return false;
  return (
    segments[0] === '.hybridclaw' &&
    segments[segments.length - 1] === 'workspace-state.json'
  );
}

function collectFilesRecursively(
  rootDir: string,
  options: {
    excludeTopLevelNames?: Set<string>;
    excludeDirectoryNames?: Set<string>;
    excludeRelativePath?: (relativePath: string) => boolean;
  } = {},
): ArchivedFile[] {
  if (!fs.existsSync(rootDir)) return [];

  const files: ArchivedFile[] = [];
  const stack = [''];
  while (stack.length > 0) {
    const relativeDir = stack.pop();
    if (relativeDir == null) continue;
    const absoluteDir = relativeDir ? path.join(rootDir, relativeDir) : rootDir;
    const entries = fs
      .readdirSync(absoluteDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (!relativeDir && options.excludeTopLevelNames?.has(entry.name)) {
        continue;
      }

      const absolutePath = path.join(absoluteDir, entry.name);
      const relativePath = relativeDir
        ? path.posix.join(relativeDir.split(path.sep).join('/'), entry.name)
        : entry.name;
      if (options.excludeRelativePath?.(relativePath)) {
        continue;
      }
      const stats = fs.lstatSync(absolutePath);
      if (stats.isSymbolicLink()) {
        throw new Error(`Refusing to package symlinked path ${absolutePath}.`);
      }
      if (stats.isDirectory()) {
        if (options.excludeDirectoryNames?.has(entry.name)) {
          continue;
        }
        stack.push(relativePath);
        continue;
      }
      if (!stats.isFile()) continue;
      files.push({
        absolutePath,
        relativePath: relativePath.split(path.sep).join('/'),
      });
    }
  }

  return files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

function discoverWorkspaceSkills(workspaceDir: string): PackSkillCandidate[] {
  const skillsDir = path.join(workspaceDir, 'skills');
  if (!fs.existsSync(skillsDir)) return [];

  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      directoryName: entry.name,
      sourceDir: path.join(skillsDir, entry.name),
    }))
    .filter((entry) =>
      fs.existsSync(path.join(entry.sourceDir, SKILL_MANIFEST_FILE)),
    )
    .sort((left, right) =>
      left.directoryName.localeCompare(right.directoryName),
    );
}

function isSkillDisabled(
  directoryName: string,
  runtimeConfig: RuntimeConfig,
): boolean {
  const normalizedDirectoryName = normalizeString(directoryName);
  if (!normalizedDirectoryName) return false;
  return runtimeConfig.skills.disabled.some(
    (entry) => normalizeString(entry) === normalizedDirectoryName,
  );
}

function isPluginDisabled(
  pluginId: string,
  runtimeConfig: RuntimeConfig,
): boolean {
  return runtimeConfig.plugins.list.some(
    (entry) =>
      normalizeString(entry.id) === pluginId && entry.enabled === false,
  );
}

function readPackageName(sourceDir: string): string | null {
  const packageJsonPath = path.join(sourceDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
      name?: unknown;
    };
    const name = normalizeString(parsed.name);
    return name || null;
  } catch {
    return null;
  }
}

function discoverHomePlugins(homeDir: string): PackPluginCandidate[] {
  const pluginsRoot = path.join(homeDir, '.hybridclaw', 'plugins');
  if (!fs.existsSync(pluginsRoot)) return [];

  const plugins: PackPluginCandidate[] = [];
  for (const entry of fs
    .readdirSync(pluginsRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const sourceDir = path.join(pluginsRoot, entry.name);
    const manifestPath = path.join(sourceDir, PLUGIN_MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) continue;

    const manifest = loadPluginManifest(manifestPath);
    plugins.push({
      pluginId: manifest.id,
      sourceDir,
      packageName: readPackageName(sourceDir),
      manifest,
    });
  }

  return plugins;
}

function buildPluginConfigList(
  runtimeConfig: RuntimeConfig,
  bundledPlugins: PackPluginCandidate[],
): NonNullable<NonNullable<ClawManifest['config']>['plugins']>['list'] {
  const bundledById = new Map(
    bundledPlugins.map((plugin) => [plugin.pluginId, plugin]),
  );
  const out = runtimeConfig.plugins.list
    .map((entry) => {
      const pluginId = normalizeString(entry.id);
      if (!pluginId) return null;

      const bundled = bundledById.get(pluginId);
      if (!bundled) return null;

      const rawConfig = isRecord(entry.config) ? { ...entry.config } : {};
      const sanitizedConfig =
        Object.keys(rawConfig).length > 0 && bundled.manifest.configSchema
          ? validatePluginConfig(bundled.manifest.configSchema, rawConfig)
          : {};

      if (entry.enabled !== false || Object.keys(sanitizedConfig).length > 0) {
        return {
          id: pluginId,
          enabled: entry.enabled !== false,
          ...(Object.keys(sanitizedConfig).length > 0
            ? { config: sanitizedConfig }
            : {}),
        };
      }

      return null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry != null);
  return out.length > 0 ? out : undefined;
}

const ARCHIVE_PLUGIN_CONFIG_MAX_DEPTH = 8;
const ARCHIVE_PLUGIN_CONFIG_MAX_BYTES = 32 * 1024;

function assertArchivePluginConfigSafe(
  value: unknown,
  pluginId: string,
  depth = 0,
): void {
  if (depth > ARCHIVE_PLUGIN_CONFIG_MAX_DEPTH) {
    throw new Error(
      `Archive plugin config for "${pluginId}" exceeds the maximum nesting depth.`,
    );
  }
  if (
    value == null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertArchivePluginConfigSafe(entry, pluginId, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    throw new Error(
      `Archive plugin config for "${pluginId}" must be JSON-safe.`,
    );
  }
  for (const nestedValue of Object.values(value)) {
    assertArchivePluginConfigSafe(nestedValue, pluginId, depth + 1);
  }
}

function sanitizeArchivePluginOverrideEntries(
  entries:
    | NonNullable<NonNullable<ClawManifest['config']>['plugins']>['list']
    | undefined,
  bundledManifests: Map<string, PluginManifest>,
): Array<{
  id: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}> {
  const sanitized: Array<{
    id: string;
    enabled: boolean;
    config?: Record<string, unknown>;
  }> = [];

  for (const entry of entries ?? []) {
    const manifest = bundledManifests.get(entry.id);
    if (!manifest) continue;

    const rawConfig = isRecord(entry.config) ? { ...entry.config } : {};
    if (Object.keys(rawConfig).length > 0) {
      const encoded = JSON.stringify(rawConfig);
      if (
        encoded &&
        Buffer.byteLength(encoded, 'utf-8') > ARCHIVE_PLUGIN_CONFIG_MAX_BYTES
      ) {
        throw new Error(
          `Archive plugin config for "${entry.id}" exceeds the size limit.`,
        );
      }
      assertArchivePluginConfigSafe(rawConfig, entry.id);
    }

    const validatedConfig = manifest.configSchema
      ? validatePluginConfig(manifest.configSchema, rawConfig)
      : {};

    if (entry.enabled !== false || Object.keys(validatedConfig).length > 0) {
      sanitized.push({
        id: entry.id,
        enabled: entry.enabled !== false,
        ...(Object.keys(validatedConfig).length > 0
          ? { config: validatedConfig }
          : {}),
      });
    }
  }

  return sanitized;
}

function createDefaultArchivePath(
  cwd: string,
  manifest: Pick<ClawManifest, 'name' | 'id'>,
): string {
  const stem = sanitizeArchiveFileStem(manifest.id || manifest.name);
  return path.join(cwd, `${stem}.claw`);
}

function createSiblingTempPath(targetPath: string, label: string): string {
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${label}-${randomUUID().slice(0, 8)}`,
  );
}

function addFilesToZip(
  zipFile: yazl.ZipFile,
  archiveRoot: string,
  files: ArchivedFile[],
): void {
  for (const file of files) {
    zipFile.addFile(
      file.absolutePath,
      path.posix.join(archiveRoot, file.relativePath),
    );
  }
}

function buildArchiveEntryNames(params: {
  workspaceFiles: ArchivedFile[];
  bundledSkillFiles: Map<string, ArchivedFile[]>;
  bundledPluginFiles: Map<string, ArchivedFile[]>;
}): string[] {
  const entries = [MANIFEST_FILE_NAME];

  entries.push(
    ...params.workspaceFiles.map((file) =>
      path.posix.join('workspace', file.relativePath),
    ),
  );
  for (const [directoryName, files] of params.bundledSkillFiles) {
    entries.push(
      ...files.map((file) =>
        path.posix.join('skills', directoryName, file.relativePath),
      ),
    );
  }
  for (const [pluginId, files] of params.bundledPluginFiles) {
    entries.push(
      ...files.map((file) =>
        path.posix.join('plugins', pluginId, file.relativePath),
      ),
    );
  }

  return entries.sort((left, right) => left.localeCompare(right));
}

function writeZipArchive(
  outputPath: string,
  manifest: ClawManifest,
  workspaceFiles: ArchivedFile[],
  bundledSkillFiles: Map<string, ArchivedFile[]>,
  bundledPluginFiles: Map<string, ArchivedFile[]>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const zipFile = new yazl.ZipFile();
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const output = fs.createWriteStream(outputPath);
    const fail = (error: unknown) => {
      output.destroy();
      fs.rmSync(outputPath, { force: true });
      reject(error);
    };

    output.on('error', fail);
    output.on('close', resolve);
    zipFile.outputStream.on('error', fail).pipe(output);

    zipFile.addBuffer(
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf-8'),
      MANIFEST_FILE_NAME,
    );
    addFilesToZip(zipFile, 'workspace', workspaceFiles);

    for (const [directoryName, files] of bundledSkillFiles) {
      addFilesToZip(zipFile, path.posix.join('skills', directoryName), files);
    }
    for (const [pluginId, files] of bundledPluginFiles) {
      addFilesToZip(zipFile, path.posix.join('plugins', pluginId), files);
    }

    zipFile.end();
  });
}

function copyDirectoryContents(
  sourceDir: string,
  destinationDir: string,
): void {
  const assertNoSymlinks = (currentPath: string): void => {
    const stats = fs.lstatSync(currentPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to copy symlinked path ${currentPath}.`);
    }
    if (!stats.isDirectory()) {
      return;
    }
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      assertNoSymlinks(path.join(currentPath, entry.name));
    }
  };

  fs.mkdirSync(destinationDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    assertNoSymlinks(sourcePath);
    fs.cpSync(sourcePath, destinationPath, {
      recursive: true,
      force: true,
    });
  }
}

function mergeUniqueSorted(
  values: string[],
  additions: Iterable<string>,
): string[] {
  const merged = new Set(
    values.map((value) => normalizeString(value)).filter(Boolean),
  );
  for (const addition of additions) {
    const normalized = normalizeString(addition);
    if (!normalized) continue;
    merged.add(normalized);
  }
  return [...merged].sort((left, right) => left.localeCompare(right));
}

function buildExternalActionLines(
  manifest: ClawManifest,
  workspacePath: string,
): string[] {
  const lines: string[] = [];

  for (const skill of manifest.skills?.external ?? []) {
    const targetDir = path.join(
      workspacePath,
      'skills',
      sanitizeArchiveFileStem(skill.name || path.basename(skill.ref, '.git')),
    );
    lines.push(`git clone ${skill.ref} ${targetDir}`);
  }

  for (const plugin of manifest.plugins?.external ?? []) {
    lines.push(`hybridclaw plugin install ${plugin.ref}`);
  }

  return lines;
}

function formatHumanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

export function formatClawArchiveSummary(
  inspection: ClawArchiveInspection,
): string[] {
  const bundledSkills = inspection.manifest.skills?.bundled ?? [];
  const bundledPlugins = inspection.manifest.plugins?.bundled ?? [];
  const externalSkills = inspection.manifest.skills?.external ?? [];
  const externalPlugins = inspection.manifest.plugins?.external ?? [];
  const lines = [
    `Name: ${inspection.manifest.name}`,
    ...(inspection.manifest.description
      ? [`Description: ${inspection.manifest.description}`]
      : []),
    ...(inspection.manifest.author
      ? [`Author: ${inspection.manifest.author}`]
      : []),
    ...(inspection.manifest.version
      ? [`Version: ${inspection.manifest.version}`]
      : []),
    ...(inspection.manifest.id
      ? [`Suggested id: ${inspection.manifest.id}`]
      : []),
    ...(inspection.manifest.agent?.model
      ? [
          `Model: ${
            typeof inspection.manifest.agent.model === 'string'
              ? inspection.manifest.agent.model
              : inspection.manifest.agent.model.primary
          }`,
        ]
      : []),
    ...(typeof inspection.manifest.agent?.enableRag === 'boolean'
      ? [`RAG: ${inspection.manifest.agent.enableRag ? 'enabled' : 'disabled'}`]
      : []),
    `Bundled skills: ${bundledSkills.length}`,
    `Bundled plugins: ${bundledPlugins.length}`,
    `External refs: ${externalSkills.length + externalPlugins.length}`,
    `Archive: ${inspection.entryNames.length} entries, ${formatHumanSize(
      inspection.totalCompressedBytes,
    )} compressed, ${formatHumanSize(inspection.totalUncompressedBytes)} extracted`,
  ];

  if (bundledSkills.length > 0) {
    lines.push(`Skill dirs: ${bundledSkills.join(', ')}`);
  }
  if (bundledPlugins.length > 0) {
    lines.push(`Plugin dirs: ${bundledPlugins.join(', ')}`);
  }
  if (externalSkills.length > 0) {
    lines.push(
      `External skills: ${externalSkills
        .map((entry) => `${entry.kind}:${entry.ref}`)
        .join(', ')}`,
    );
  }
  if (externalPlugins.length > 0) {
    lines.push(
      `External plugins: ${externalPlugins
        .map((entry) => `${entry.kind}:${entry.ref}`)
        .join(', ')}`,
    );
  }

  return lines;
}

export async function inspectClawArchive(
  archivePath: string,
): Promise<ClawArchiveInspection> {
  const scan = await scanClawArchive(archivePath, {
    textEntries: [MANIFEST_FILE_NAME],
  });
  const manifestText = scan.textEntries[MANIFEST_FILE_NAME];
  if (!manifestText) {
    throw new Error(`Archive ${archivePath} is missing ${MANIFEST_FILE_NAME}.`);
  }

  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(
      `Archive ${archivePath} has an invalid manifest.json: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const manifest = validateClawManifest(parsedManifest, {
    archiveEntries: scan.entryNames,
  });
  return {
    archivePath,
    manifest,
    totalCompressedBytes: scan.totalCompressedBytes,
    totalUncompressedBytes: scan.totalUncompressedBytes,
    entryNames: scan.entryNames,
  };
}

export async function packAgent(
  agentId = DEFAULT_AGENT_ID,
  options: PackAgentOptions = {},
): Promise<PackAgentResult> {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? os.homedir();
  const runtimeConfig = getRuntimeConfig();
  const resolved = resolveAgentConfig(agentId);
  const workspacePath = agentWorkspaceDir(resolved.id);

  if (!fs.existsSync(workspacePath)) {
    throw new Error(`Agent workspace not found: ${workspacePath}`);
  }

  const workspaceFiles = collectFilesRecursively(workspacePath, {
    excludeTopLevelNames: new Set(['skills']),
    excludeRelativePath: shouldExcludeWorkspaceArchivePath,
  });
  const skillCandidates = discoverWorkspaceSkills(workspacePath);
  const pluginCandidates = discoverHomePlugins(homeDir);

  const bundledSkillFiles = new Map<string, ArchivedFile[]>();
  const bundledPluginFiles = new Map<string, ArchivedFile[]>();
  const externalSkills: ClawSkillExternalRef[] = [];
  const externalPlugins: ClawPluginExternalRef[] = [];
  const promptSelection = options.promptSelection;
  const requestedSkillNames = new Set(
    (options.skillSelection?.names ?? [])
      .map((entry) => normalizeString(entry))
      .filter(Boolean),
  );
  const skillSelectionMode =
    options.skillSelection?.mode ?? (options.promptSelection ? 'ask' : 'all');
  const requestedPluginIds = new Set(
    (options.pluginSelection?.names ?? [])
      .map((entry) => normalizeString(entry))
      .filter(Boolean),
  );
  const pluginSelectionMode =
    options.pluginSelection?.mode ??
    (options.promptSelection ? 'ask' : 'active');

  if (skillSelectionMode === 'ask' && !promptSelection) {
    throw new Error(
      'Interactive skill selection requires an available prompt.',
    );
  }
  if (skillSelectionMode === 'some' && requestedSkillNames.size === 0) {
    throw new Error(
      'Explicit skill selection requires at least one workspace skill name.',
    );
  }
  if (pluginSelectionMode === 'ask' && !promptSelection) {
    throw new Error(
      'Interactive plugin selection requires an available prompt.',
    );
  }
  if (pluginSelectionMode === 'some' && requestedPluginIds.size === 0) {
    throw new Error(
      'Explicit plugin selection requires at least one installed plugin id.',
    );
  }

  for (const candidate of skillCandidates) {
    let selection: ClawPackSelection = { mode: 'bundle' };
    if (skillSelectionMode === 'ask') {
      if (!promptSelection) {
        throw new Error(
          'Interactive skill selection requires an available prompt.',
        );
      }
      selection = await promptSelection({
        kind: 'skill',
        directoryName: candidate.directoryName,
        sourceDir: candidate.sourceDir,
      });
    } else if (skillSelectionMode === 'active') {
      if (isSkillDisabled(candidate.directoryName, runtimeConfig)) {
        continue;
      }
    } else if (skillSelectionMode === 'some') {
      const normalizedDirectoryName = normalizeString(candidate.directoryName);
      if (
        !normalizedDirectoryName ||
        !requestedSkillNames.has(normalizedDirectoryName)
      ) {
        continue;
      }
    }

    if (selection.mode === 'external') {
      externalSkills.push(selection.reference as ClawSkillExternalRef);
      continue;
    }
    if (selection.mode === 'skip') {
      continue;
    }
    bundledSkillFiles.set(
      candidate.directoryName,
      collectFilesRecursively(candidate.sourceDir, {
        excludeDirectoryNames: new Set(['.git']),
        excludeRelativePath: shouldExcludePortableArchivePath,
      }),
    );
  }

  if (skillSelectionMode === 'some') {
    const discoveredSkillNames = new Set(
      skillCandidates
        .map((candidate) => normalizeString(candidate.directoryName))
        .filter(Boolean),
    );
    const missing = [...requestedSkillNames]
      .filter((name) => !discoveredSkillNames.has(name))
      .sort((left, right) => left.localeCompare(right));
    if (missing.length > 0) {
      throw new Error(
        `Requested workspace skills not found: ${missing.join(', ')}.`,
      );
    }
  }

  for (const candidate of pluginCandidates) {
    let selection: ClawPackSelection = { mode: 'bundle' };
    if (pluginSelectionMode === 'ask') {
      if (isPluginDisabled(candidate.pluginId, runtimeConfig)) {
        continue;
      }
      if (!promptSelection) {
        throw new Error(
          'Interactive plugin selection requires an available prompt.',
        );
      }
      selection = await promptSelection({
        kind: 'plugin',
        pluginId: candidate.pluginId,
        sourceDir: candidate.sourceDir,
        packageName: candidate.packageName,
      });
    } else if (pluginSelectionMode === 'active') {
      if (isPluginDisabled(candidate.pluginId, runtimeConfig)) {
        continue;
      }
    } else if (pluginSelectionMode === 'some') {
      const normalizedPluginId = normalizeString(candidate.pluginId);
      if (!normalizedPluginId || !requestedPluginIds.has(normalizedPluginId)) {
        continue;
      }
    }

    if (selection.mode === 'external') {
      externalPlugins.push(selection.reference as ClawPluginExternalRef);
      continue;
    }
    if (selection.mode === 'skip') {
      continue;
    }
    bundledPluginFiles.set(
      candidate.pluginId,
      collectFilesRecursively(candidate.sourceDir, {
        excludeDirectoryNames: new Set(['.git', 'node_modules']),
        excludeRelativePath: shouldExcludePortableArchivePath,
      }),
    );
  }

  if (pluginSelectionMode === 'some') {
    const discoveredPluginIds = new Set(
      pluginCandidates
        .map((candidate) => normalizeString(candidate.pluginId))
        .filter(Boolean),
    );
    const missing = [...requestedPluginIds]
      .filter((id) => !discoveredPluginIds.has(id))
      .sort((left, right) => left.localeCompare(right));
    if (missing.length > 0) {
      throw new Error(`Requested plugins not found: ${missing.join(', ')}.`);
    }
  }

  const bundledPluginCandidates = pluginCandidates.filter((candidate) =>
    bundledPluginFiles.has(candidate.pluginId),
  );
  const pluginConfigList = buildPluginConfigList(
    runtimeConfig,
    bundledPluginCandidates,
  );

  const manifest = validateClawManifest({
    formatVersion: CLAW_FORMAT_VERSION,
    name: normalizeString(resolved.name) || resolved.id,
    id: sanitizeClawAgentId(resolved.id),
    ...(normalizeString(options.manifestMetadata?.description)
      ? { description: normalizeString(options.manifestMetadata?.description) }
      : {}),
    ...(normalizeString(options.manifestMetadata?.author)
      ? { author: normalizeString(options.manifestMetadata?.author) }
      : {}),
    ...(normalizeString(options.manifestMetadata?.version)
      ? { version: normalizeString(options.manifestMetadata?.version) }
      : {}),
    createdAt: options.createdAt ?? new Date().toISOString(),
    agent: {
      ...(resolved.model ? { model: resolved.model } : {}),
      ...(typeof resolved.enableRag === 'boolean'
        ? { enableRag: resolved.enableRag }
        : {}),
    },
    skills: {
      ...(bundledSkillFiles.size > 0
        ? { bundled: [...bundledSkillFiles.keys()] }
        : {}),
      ...(externalSkills.length > 0 ? { external: externalSkills } : {}),
    },
    plugins: {
      ...(bundledPluginFiles.size > 0
        ? { bundled: [...bundledPluginFiles.keys()] }
        : {}),
      ...(externalPlugins.length > 0 ? { external: externalPlugins } : {}),
    },
    config: {
      ...(runtimeConfig.skills.disabled.length > 0
        ? { skills: { disabled: [...runtimeConfig.skills.disabled] } }
        : {}),
      ...(pluginConfigList ? { plugins: { list: pluginConfigList } } : {}),
    },
  });

  const archivePath =
    options.outputPath || createDefaultArchivePath(cwd, manifest);
  const archiveEntries = buildArchiveEntryNames({
    workspaceFiles,
    bundledSkillFiles,
    bundledPluginFiles,
  });
  if (!options.dryRun) {
    await writeZipArchive(
      archivePath,
      manifest,
      workspaceFiles,
      bundledSkillFiles,
      bundledPluginFiles,
    );
  }

  return {
    archivePath,
    manifest,
    workspacePath,
    bundledSkills: [...bundledSkillFiles.keys()],
    bundledPlugins: [...bundledPluginFiles.keys()],
    externalSkills,
    externalPlugins,
    archiveEntries,
  };
}

export async function unpackAgent(
  archivePath: string,
  options: UnpackAgentOptions = {},
): Promise<UnpackAgentResult> {
  const inspection = await inspectClawArchive(archivePath);

  if (!options.yes) {
    const confirmed = options.confirm
      ? await options.confirm(inspection)
      : true;
    if (!confirmed) {
      throw new Error('Agent unpack cancelled.');
    }
  }

  const resolvedAgentId = sanitizeClawAgentId(
    options.agentId ||
      inspection.manifest.id ||
      inspection.manifest.name ||
      DEFAULT_AGENT_ID,
  );

  const existing = getAgentById(resolvedAgentId);
  if (existing && !options.force) {
    throw new Error(
      `Agent "${resolvedAgentId}" already exists. Re-run with --force to replace it.`,
    );
  }

  const tempRoot = options.tempRoot ?? os.tmpdir();
  const extractionRoot = fs.mkdtempSync(
    path.join(tempRoot, 'hybridclaw-claw-unpack-'),
  );
  const extractedArchiveDir = path.join(extractionRoot, 'archive');
  const workspacePath = agentWorkspaceDir(resolvedAgentId);
  const workspaceExists = fs.existsSync(workspacePath);
  const previousRuntimeConfig = structuredClone(getRuntimeConfig());
  const previousAgentConfig = existing ? structuredClone(existing) : null;
  const installedPlugins: InstallPluginResult[] = [];
  let runtimeConfigChanged = false;
  const rollbackPluginInstalls: PluginInstallRollbackState[] = [];
  let stagedWorkspacePath = '';
  let workspaceBackupPath = '';
  let workspaceCommitted = false;
  let agentRegistered = false;

  try {
    await safeExtractZip(archivePath, extractedArchiveDir);

    const manifestPath = path.join(extractedArchiveDir, MANIFEST_FILE_NAME);
    if (!fs.existsSync(manifestPath)) {
      throw new Error(
        `Archive ${archivePath} is missing ${MANIFEST_FILE_NAME}.`,
      );
    }

    const rawManifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf-8'),
    ) as unknown;
    const manifest = validateClawManifest(rawManifest, {
      archiveEntries: inspection.entryNames,
    });

    const workspaceSourceDir = path.join(extractedArchiveDir, 'workspace');
    if (!fs.existsSync(workspaceSourceDir)) {
      throw new Error('Archive does not contain a workspace/ directory.');
    }

    if (!options.force && workspaceExists) {
      throw new Error(
        `Workspace for agent "${resolvedAgentId}" already exists at ${workspacePath}.`,
      );
    }
    stagedWorkspacePath = createSiblingTempPath(workspacePath, 'claw-import');
    copyDirectoryContents(workspaceSourceDir, stagedWorkspacePath);

    const bundledSkills = manifest.skills?.bundled ?? [];
    for (const directoryName of bundledSkills) {
      const sourceDir = path.join(extractedArchiveDir, 'skills', directoryName);
      if (!fs.existsSync(sourceDir)) {
        throw new Error(
          `Archive is missing bundled skill directory ${directoryName}.`,
        );
      }
      const destinationDir = path.join(
        stagedWorkspacePath,
        'skills',
        directoryName,
      );
      fs.rmSync(destinationDir, { recursive: true, force: true });
      copyDirectoryContents(sourceDir, destinationDir);
    }

    const pluginHomeDir = options.homeDir ?? os.homedir();
    const pluginInstallRoot = path.join(
      pluginHomeDir,
      '.hybridclaw',
      'plugins',
    );
    fs.mkdirSync(pluginInstallRoot, { recursive: true });
    const bundledPluginManifests = new Map<string, PluginManifest>();
    for (const pluginId of manifest.plugins?.bundled ?? []) {
      const sourceDir = path.join(extractedArchiveDir, 'plugins', pluginId);
      if (!fs.existsSync(sourceDir)) {
        throw new Error(
          `Archive is missing bundled plugin directory ${pluginId}.`,
        );
      }
      const bundledManifest = loadPluginManifest(
        path.join(sourceDir, PLUGIN_MANIFEST_FILE),
      );
      if (bundledManifest.id !== pluginId) {
        throw new Error(
          `Bundled plugin directory "${pluginId}" did not match manifest id "${bundledManifest.id}".`,
        );
      }
      bundledPluginManifests.set(pluginId, bundledManifest);
      const pluginDir = path.join(pluginInstallRoot, pluginId);
      let backupDir: string | null = null;
      if (options.force && fs.existsSync(pluginDir)) {
        backupDir = createSiblingTempPath(pluginDir, 'claw-rollback');
        fs.renameSync(pluginDir, backupDir);
      }
      rollbackPluginInstalls.push({
        pluginDir,
        backupDir,
      });
      const installResult = await installPlugin(sourceDir, {
        homeDir: pluginHomeDir,
        cwd: options.cwd ?? process.cwd(),
        runCommand: options.runCommand,
      });
      installedPlugins.push(installResult);
    }

    if (workspaceExists && options.force) {
      workspaceBackupPath = createSiblingTempPath(
        workspacePath,
        'claw-rollback',
      );
      fs.renameSync(workspacePath, workspaceBackupPath);
    }
    fs.renameSync(stagedWorkspacePath, workspacePath);
    stagedWorkspacePath = '';
    workspaceCommitted = true;

    upsertRegisteredAgent({
      id: resolvedAgentId,
      name: manifest.name,
      ...(manifest.agent?.model ? { model: manifest.agent.model } : {}),
      ...(typeof manifest.agent?.enableRag === 'boolean'
        ? { enableRag: manifest.agent.enableRag }
        : {}),
    });
    agentRegistered = true;

    const workspaceSkillsDir = path.join(workspacePath, 'skills');
    const nextDisabledSkills = mergeUniqueSorted(
      previousRuntimeConfig.skills.disabled,
      manifest.config?.skills?.disabled ?? [],
    );
    const incomingPluginConfig = sanitizeArchivePluginOverrideEntries(
      manifest.config?.plugins?.list ?? [],
      bundledPluginManifests,
    );

    if (
      bundledSkills.length > 0 ||
      nextDisabledSkills.length !==
        previousRuntimeConfig.skills.disabled.length ||
      incomingPluginConfig.length > 0
    ) {
      updateRuntimeConfig((draft) => {
        if (bundledSkills.length > 0) {
          draft.skills.extraDirs = mergeUniqueSorted(draft.skills.extraDirs, [
            workspaceSkillsDir,
          ]);
        }
        if ((manifest.config?.skills?.disabled ?? []).length > 0) {
          draft.skills.disabled = mergeUniqueSorted(
            draft.skills.disabled,
            manifest.config?.skills?.disabled ?? [],
          );
        }
        for (const entry of incomingPluginConfig) {
          const index = draft.plugins.list.findIndex(
            (candidate) => normalizeString(candidate.id) === entry.id,
          );
          const nextEntry = {
            id: entry.id,
            enabled: entry.enabled !== false,
            ...(entry.config
              ? { config: { ...entry.config } }
              : { config: {} }),
          };
          if (index === -1) {
            draft.plugins.list.push(nextEntry);
            continue;
          }
          draft.plugins.list[index] = nextEntry;
        }
      });
      runtimeConfigChanged = true;
    }

    ensureBootstrapFiles(resolvedAgentId);

    if (workspaceBackupPath) {
      fs.rmSync(workspaceBackupPath, { recursive: true, force: true });
      workspaceBackupPath = '';
    }
    for (const rollbackState of rollbackPluginInstalls) {
      if (rollbackState.backupDir) {
        fs.rmSync(rollbackState.backupDir, { recursive: true, force: true });
      }
    }

    return {
      archivePath,
      manifest,
      agentId: resolvedAgentId,
      workspacePath,
      bundledSkills,
      installedPlugins,
      externalActions: options.skipExternals
        ? []
        : buildExternalActionLines(manifest, workspacePath),
      runtimeConfigChanged,
    };
  } catch (error) {
    if (runtimeConfigChanged) {
      updateRuntimeConfig((draft) => {
        Object.assign(draft, structuredClone(previousRuntimeConfig));
      });
    }
    if (agentRegistered) {
      if (previousAgentConfig) {
        upsertRegisteredAgent(previousAgentConfig);
      } else {
        deleteRegisteredAgent(resolvedAgentId);
      }
    }
    if (workspaceCommitted && fs.existsSync(workspacePath)) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
    if (workspaceBackupPath && fs.existsSync(workspaceBackupPath)) {
      fs.renameSync(workspaceBackupPath, workspacePath);
      workspaceBackupPath = '';
    }
    if (stagedWorkspacePath && fs.existsSync(stagedWorkspacePath)) {
      fs.rmSync(stagedWorkspacePath, { recursive: true, force: true });
      stagedWorkspacePath = '';
    }
    for (const rollbackState of rollbackPluginInstalls.reverse()) {
      if (fs.existsSync(rollbackState.pluginDir)) {
        fs.rmSync(rollbackState.pluginDir, { recursive: true, force: true });
      }
      if (rollbackState.backupDir && fs.existsSync(rollbackState.backupDir)) {
        fs.renameSync(rollbackState.backupDir, rollbackState.pluginDir);
      }
    }
    throw error;
  } finally {
    fs.rmSync(extractionRoot, { recursive: true, force: true });
  }
}
