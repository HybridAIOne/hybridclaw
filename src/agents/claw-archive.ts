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
  reinstallPlugin,
} from '../plugins/plugin-install.js';
import { loadPluginManifest } from '../plugins/plugin-manager.js';
import { ensureBootstrapFiles } from '../workspace.js';
import {
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
}

export type ClawPackSelection =
  | { mode: 'bundle' }
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
}

export interface ClawArchiveInspection {
  archivePath: string;
  manifest: ClawManifest;
  entryCount: number;
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

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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

function collectFilesRecursively(
  rootDir: string,
  options: {
    excludeTopLevelNames?: Set<string>;
    excludeDirectoryNames?: Set<string>;
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

function discoverEnabledHomePlugins(
  homeDir: string,
  runtimeConfig: RuntimeConfig,
): PackPluginCandidate[] {
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
    if (isPluginDisabled(manifest.id, runtimeConfig)) continue;
    plugins.push({
      pluginId: manifest.id,
      sourceDir,
      packageName: readPackageName(sourceDir),
    });
  }

  return plugins;
}

function buildPluginConfigList(
  runtimeConfig: RuntimeConfig,
  includedPluginIds: Set<string>,
): NonNullable<NonNullable<ClawManifest['config']>['plugins']>['list'] {
  const out = runtimeConfig.plugins.list
    .filter((entry) => includedPluginIds.has(normalizeString(entry.id)))
    .map((entry) => ({
      id: normalizeString(entry.id),
      enabled: entry.enabled !== false,
      ...(entry.config &&
      typeof entry.config === 'object' &&
      !Array.isArray(entry.config)
        ? { config: { ...entry.config } }
        : {}),
    }))
    .filter((entry) => entry.id);
  return out.length > 0 ? out : undefined;
}

function createDefaultArchivePath(
  cwd: string,
  manifest: Pick<ClawManifest, 'name' | 'id'>,
): string {
  const stem = sanitizeArchiveFileStem(manifest.id || manifest.name);
  return path.join(cwd, `${stem}.claw`);
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
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    fs.cpSync(sourcePath, destinationPath, {
      recursive: true,
      dereference: true,
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
    if (skill.kind === 'git') {
      const targetDir = path.join(
        workspacePath,
        'skills',
        sanitizeArchiveFileStem(skill.name || path.basename(skill.ref, '.git')),
      );
      lines.push(`git clone ${skill.ref} ${targetDir}`);
      continue;
    }
    lines.push(
      `Resolve external skill manually: ${skill.kind} ${skill.name ? `${skill.name} ` : ''}${skill.ref}`,
    );
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
    `Bundled skills: ${(inspection.manifest.skills?.bundled ?? []).length}`,
    `Bundled plugins: ${(inspection.manifest.plugins?.bundled ?? []).length}`,
    `External refs: ${
      (inspection.manifest.skills?.external ?? []).length +
      (inspection.manifest.plugins?.external ?? []).length
    }`,
    `Archive: ${inspection.entryCount} entries, ${formatHumanSize(
      inspection.totalCompressedBytes,
    )} compressed, ${formatHumanSize(inspection.totalUncompressedBytes)} extracted`,
  ];

  if ((inspection.manifest.skills?.bundled ?? []).length > 0) {
    lines.push(
      `Skill dirs: ${(inspection.manifest.skills?.bundled ?? []).join(', ')}`,
    );
  }
  if ((inspection.manifest.plugins?.bundled ?? []).length > 0) {
    lines.push(
      `Plugin dirs: ${(inspection.manifest.plugins?.bundled ?? []).join(', ')}`,
    );
  }
  if ((inspection.manifest.skills?.external ?? []).length > 0) {
    lines.push(
      `External skills: ${(inspection.manifest.skills?.external ?? [])
        .map((entry) => `${entry.kind}:${entry.ref}`)
        .join(', ')}`,
    );
  }
  if ((inspection.manifest.plugins?.external ?? []).length > 0) {
    lines.push(
      `External plugins: ${(inspection.manifest.plugins?.external ?? [])
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
    entryCount: scan.entries.length,
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
  });
  const skillCandidates = discoverWorkspaceSkills(workspacePath);
  const pluginCandidates = discoverEnabledHomePlugins(homeDir, runtimeConfig);

  const bundledSkillFiles = new Map<string, ArchivedFile[]>();
  const bundledPluginFiles = new Map<string, ArchivedFile[]>();
  const externalSkills: ClawSkillExternalRef[] = [];
  const externalPlugins: ClawPluginExternalRef[] = [];

  for (const candidate of skillCandidates) {
    const selection = options.promptSelection
      ? await options.promptSelection({
          kind: 'skill',
          directoryName: candidate.directoryName,
          sourceDir: candidate.sourceDir,
        })
      : { mode: 'bundle' as const };
    if (selection.mode === 'external') {
      externalSkills.push(selection.reference as ClawSkillExternalRef);
      continue;
    }
    bundledSkillFiles.set(
      candidate.directoryName,
      collectFilesRecursively(candidate.sourceDir, {
        excludeDirectoryNames: new Set(['.git']),
      }),
    );
  }

  for (const candidate of pluginCandidates) {
    const selection = options.promptSelection
      ? await options.promptSelection({
          kind: 'plugin',
          pluginId: candidate.pluginId,
          sourceDir: candidate.sourceDir,
          packageName: candidate.packageName,
        })
      : { mode: 'bundle' as const };
    if (selection.mode === 'external') {
      externalPlugins.push(selection.reference as ClawPluginExternalRef);
      continue;
    }
    bundledPluginFiles.set(
      candidate.pluginId,
      collectFilesRecursively(candidate.sourceDir, {
        excludeDirectoryNames: new Set(['.git', 'node_modules']),
      }),
    );
  }

  const includedPluginIds = new Set<string>([
    ...bundledPluginFiles.keys(),
    ...externalPlugins
      .map((entry) => normalizeString(entry.id))
      .filter(Boolean),
  ]);
  const pluginConfigList = buildPluginConfigList(
    runtimeConfig,
    includedPluginIds,
  );

  const manifest = validateClawManifest({
    formatVersion: CLAW_FORMAT_VERSION,
    name: normalizeString(resolved.name) || resolved.id,
    id: sanitizeClawAgentId(resolved.id),
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
  await writeZipArchive(
    archivePath,
    manifest,
    workspaceFiles,
    bundledSkillFiles,
    bundledPluginFiles,
  );

  return {
    archivePath,
    manifest,
    workspacePath,
    bundledSkills: [...bundledSkillFiles.keys()],
    bundledPlugins: [...bundledPluginFiles.keys()],
    externalSkills,
    externalPlugins,
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
  const installedPlugins: InstallPluginResult[] = [];
  let runtimeConfigChanged = false;

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
    const manifest = validateClawManifest(rawManifest);

    const workspaceSourceDir = path.join(extractedArchiveDir, 'workspace');
    if (!fs.existsSync(workspaceSourceDir)) {
      throw new Error('Archive does not contain a workspace/ directory.');
    }

    const workspacePath = agentWorkspaceDir(resolvedAgentId);
    if (options.force) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    } else if (fs.existsSync(workspacePath)) {
      throw new Error(
        `Workspace for agent "${resolvedAgentId}" already exists at ${workspacePath}.`,
      );
    }

    upsertRegisteredAgent({
      id: resolvedAgentId,
      name: manifest.name,
      ...(manifest.agent?.model ? { model: manifest.agent.model } : {}),
      ...(typeof manifest.agent?.enableRag === 'boolean'
        ? { enableRag: manifest.agent.enableRag }
        : {}),
    });

    copyDirectoryContents(workspaceSourceDir, workspacePath);

    const bundledSkills = manifest.skills?.bundled ?? [];
    for (const directoryName of bundledSkills) {
      const sourceDir = path.join(extractedArchiveDir, 'skills', directoryName);
      if (!fs.existsSync(sourceDir)) {
        throw new Error(
          `Archive is missing bundled skill directory ${directoryName}.`,
        );
      }
      const destinationDir = path.join(workspacePath, 'skills', directoryName);
      fs.rmSync(destinationDir, { recursive: true, force: true });
      copyDirectoryContents(sourceDir, destinationDir);
    }

    const pluginHomeDir = options.homeDir ?? os.homedir();
    for (const pluginId of manifest.plugins?.bundled ?? []) {
      const sourceDir = path.join(extractedArchiveDir, 'plugins', pluginId);
      if (!fs.existsSync(sourceDir)) {
        throw new Error(
          `Archive is missing bundled plugin directory ${pluginId}.`,
        );
      }
      const installResult = options.force
        ? await reinstallPlugin(sourceDir, {
            homeDir: pluginHomeDir,
            cwd: options.cwd ?? process.cwd(),
            runCommand: options.runCommand,
          })
        : await installPlugin(sourceDir, {
            homeDir: pluginHomeDir,
            cwd: options.cwd ?? process.cwd(),
            runCommand: options.runCommand,
          });
      installedPlugins.push(installResult);
    }

    const workspaceSkillsDir = path.join(workspacePath, 'skills');
    const nextDisabledSkills = mergeUniqueSorted(
      getRuntimeConfig().skills.disabled,
      manifest.config?.skills?.disabled ?? [],
    );
    const incomingPluginConfig = manifest.config?.plugins?.list ?? [];

    if (
      bundledSkills.length > 0 ||
      nextDisabledSkills.length !== getRuntimeConfig().skills.disabled.length ||
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
  } finally {
    fs.rmSync(extractionRoot, { recursive: true, force: true });
  }
}
