import fs from 'node:fs';
import path from 'node:path';
import { appendAuditEvent, createAuditRunId } from '../audit/audit-trail.js';
import type { SkillConfigChannelKind } from '../channels/channel.js';
import {
  getRuntimeAssetRevision,
  getRuntimeConfig,
  listRuntimeAssetRevisions,
  type RuntimeConfig,
  type RuntimeConfigChangeMeta,
  type RuntimeConfigRevisionSummary,
  type RuntimeInstalledSkillManifest,
  setRuntimeSkillScopeEnabled,
  syncRuntimeAssetRevisionState,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import { isRecord } from '../utils/type-guards.js';
import {
  assertImportBudget,
  assertSafeRelativePath,
  recordImportedFile,
} from './skill-import-commons.js';
import {
  parseSkillManifestFile,
  type SkillManifest,
} from './skill-manifest.js';
import {
  loadSkillCatalog,
  resolveManagedCommunitySkillsDir,
  type SkillCatalogEntry,
} from './skills.js';
import type { SkillImportResult } from './skills-import.js';
import { importSkill } from './skills-import.js';

const SKILL_LIFECYCLE_SESSION_ID = 'skill-lifecycle';
const SKILL_PACKAGE_SNAPSHOT_FILE = '.hybridclaw-skill-snapshot.json';

export type SkillLifecycleAction =
  | 'install'
  | 'upgrade'
  | 'uninstall'
  | 'disable'
  | 'enable'
  | 'rollback';

export interface SkillPackageLifecycleOptions {
  actor?: string;
  force?: boolean;
  homeDir?: string;
  skipGuard?: boolean;
}

export interface SkillPackageInstallResult extends SkillImportResult {
  action: 'install' | 'upgrade';
  manifest: SkillManifest;
  revisionAssetPath: string;
}

export interface SkillPackageStatusResult {
  action: 'enable' | 'disable';
  skillName: string;
  scope: SkillConfigChannelKind | 'global';
  manifest: SkillManifest | null;
}

export interface SkillPackageUninstallResult {
  action: 'uninstall';
  skillName: string;
  skillDir: string;
  manifest: SkillManifest | null;
  revisionAssetPath: string;
}

export interface SkillPackageRollbackResult {
  action: 'rollback';
  skillName: string;
  skillDir: string;
  revisionId: number;
  manifest: SkillManifest;
  revisionAssetPath: string;
}

interface SkillPackageSnapshotFile {
  path: string;
  mode: number;
  contentBase64: string;
}

interface SkillPackageSnapshot {
  schemaVersion: 1;
  manifest: SkillManifest;
  files: SkillPackageSnapshotFile[];
}

const BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function pathWithin(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function actorOrDefault(actor?: string): string {
  return String(actor || '').trim() || 'skill-lifecycle';
}

function buildLifecycleMeta(params: {
  action: SkillLifecycleAction;
  actor?: string;
  source?: string;
}): RuntimeConfigChangeMeta {
  return {
    actor: actorOrDefault(params.actor),
    route: `skill.lifecycle.${params.action}`,
    source: params.source || 'skill-lifecycle',
  };
}

function resolveSkillSnapshotAssetPath(skillDir: string): string {
  return path.join(skillDir, SKILL_PACKAGE_SNAPSHOT_FILE);
}

function readSkillPackageSnapshotFile(fullPath: string): {
  content: Buffer;
  mode: number;
} {
  const fd = fs.openSync(fullPath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`Unsupported skill package entry: ${fullPath}`);
    }
    return {
      content: fs.readFileSync(fd),
      mode: stat.mode & 0o777,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function buildSkillPackageSnapshot(
  skillDir: string,
  manifest: SkillManifest,
): SkillPackageSnapshot {
  const files: SkillPackageSnapshotFile[] = [];
  const state = { fileCount: 0, totalBytes: 0 };
  const stack = [skillDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) continue;
    const entries = fs
      .readdirSync(currentDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = toPosixPath(path.relative(skillDir, fullPath));
      if (relativePath === SKILL_PACKAGE_SNAPSHOT_FILE) continue;
      assertSafeRelativePath(relativePath);

      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Unsupported skill package entry: ${relativePath}`);
      }

      const { content, mode } = readSkillPackageSnapshotFile(fullPath);
      recordImportedFile(state, content.byteLength);
      files.push({
        path: relativePath,
        mode,
        contentBase64: content.toString('base64'),
      });
    }
  }

  assertImportBudget(state, 0);
  return {
    schemaVersion: 1,
    manifest,
    files,
  };
}

function serializeSkillPackageSnapshot(
  skillDir: string,
  manifest: SkillManifest,
): string {
  return JSON.stringify(buildSkillPackageSnapshot(skillDir, manifest));
}

function parseSkillPackageSnapshot(content: string): SkillPackageSnapshot {
  const parsed = JSON.parse(content) as unknown;
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    !isRecord(parsed.manifest) ||
    !Array.isArray(parsed.files)
  ) {
    throw new Error('Skill revision snapshot is not a supported package.');
  }
  return {
    schemaVersion: 1,
    manifest: parsed.manifest as unknown as SkillManifest,
    files: parsed.files.map(parseSkillPackageSnapshotFile),
  };
}

function parseSkillPackageSnapshotFile(
  value: unknown,
  index: number,
): SkillPackageSnapshotFile {
  const label = `Skill revision snapshot file #${index + 1}`;
  if (!isRecord(value)) {
    throw new Error(`${label} is not a valid file entry.`);
  }

  const filePath = value.path;
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error(`${label} has invalid path.`);
  }
  try {
    assertSafeRelativePath(filePath);
  } catch (err) {
    throw new Error(
      `${label} has invalid path: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const mode = value.mode;
  if (
    typeof mode !== 'number' ||
    !Number.isInteger(mode) ||
    mode < 0 ||
    mode > 0o777
  ) {
    throw new Error(`${label} has invalid mode.`);
  }

  const contentBase64 = value.contentBase64;
  if (typeof contentBase64 !== 'string' || !BASE64_RE.test(contentBase64)) {
    throw new Error(`${label} has invalid contentBase64.`);
  }

  return {
    path: filePath,
    mode,
    contentBase64,
  };
}

function sanitizeRestoredSkillFileMode(mode: number): number {
  return mode & 0o644;
}

function restoreSkillPackageSnapshot(
  skillDir: string,
  snapshot: SkillPackageSnapshot,
): void {
  fs.rmSync(skillDir, { recursive: true, force: true });
  fs.mkdirSync(skillDir, { recursive: true });

  const state = { fileCount: 0, totalBytes: 0 };
  const createdDirs = new Set<string>([skillDir]);
  for (const file of snapshot.files) {
    assertSafeRelativePath(file.path);
    const content = Buffer.from(file.contentBase64, 'base64');
    recordImportedFile(state, content.byteLength);
    const targetPath = path.join(skillDir, file.path);
    const parentDir = path.dirname(targetPath);
    if (!createdDirs.has(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
      createdDirs.add(parentDir);
    }
    fs.writeFileSync(targetPath, content);
    fs.chmodSync(targetPath, sanitizeRestoredSkillFileMode(file.mode));
  }
}

function syncSkillPackageRevisionState(params: {
  skillDir: string;
  manifest: SkillManifest;
  meta: RuntimeConfigChangeMeta;
}): string {
  const assetPath = resolveSkillSnapshotAssetPath(params.skillDir);
  const content = serializeSkillPackageSnapshot(
    params.skillDir,
    params.manifest,
  );
  syncRuntimeAssetRevisionState('skill', assetPath, params.meta, {
    exists: true,
    content,
  });
  return assetPath;
}

function removeSkillPackageRevisionState(params: {
  skillDir: string;
  meta: RuntimeConfigChangeMeta;
}): string {
  const assetPath = resolveSkillSnapshotAssetPath(params.skillDir);
  syncRuntimeAssetRevisionState('skill', assetPath, params.meta, {
    exists: false,
    content: null,
  });
  return assetPath;
}

function toRuntimeInstalledSkillManifest(params: {
  manifest: SkillManifest;
  status: RuntimeInstalledSkillManifest['status'];
  previous?: RuntimeInstalledSkillManifest | null;
  source: string;
  skillDir: string;
  manifestPath?: string;
}): RuntimeInstalledSkillManifest {
  const now = new Date().toISOString();
  return {
    id: params.manifest.id,
    name: params.manifest.name,
    version: params.manifest.version,
    source: params.source,
    skillDir: params.skillDir,
    manifestPath: params.manifestPath || path.join(params.skillDir, 'SKILL.md'),
    status: params.status,
    capabilities: params.manifest.capabilities,
    requiredCredentials: params.manifest.requiredCredentials,
    supportedChannels: params.manifest.supportedChannels,
    installedAt: params.previous?.installedAt || now,
    updatedAt: now,
  };
}

function updateInstalledSkillManifest(
  draft: RuntimeConfig,
  manifest: RuntimeInstalledSkillManifest,
): void {
  const next = (draft.skills.installed || []).filter(
    (entry) => entry.id !== manifest.id && entry.name !== manifest.name,
  );
  next.push(manifest);
  draft.skills.installed = next;
}

function removeInstalledSkillManifest(
  draft: RuntimeConfig,
  manifestId: string,
): void {
  draft.skills.installed = (draft.skills.installed || []).filter(
    (entry) => entry.id !== manifestId && entry.name !== manifestId,
  );
  removeSkillFromDisabledScopes(draft, manifestId);
}

function removeSkillFromDisabledScopes(
  draft: RuntimeConfig,
  skillNameOrId: string,
): void {
  draft.skills.disabled = (draft.skills.disabled || []).filter(
    (entry) => entry !== skillNameOrId,
  );
  if (draft.skills.channelDisabled) {
    for (const channel of Object.keys(
      draft.skills.channelDisabled,
    ) as SkillConfigChannelKind[]) {
      draft.skills.channelDisabled[channel] = (
        draft.skills.channelDisabled[channel] || []
      ).filter((entry) => entry !== skillNameOrId);
    }
  }
}

function recordSkillLifecycleAudit(params: {
  action: SkillLifecycleAction;
  manifest: SkillManifest | null;
  skillName: string;
  skillDir?: string;
  source?: string;
  revisionId?: number;
  actor?: string;
}): void {
  appendAuditEvent({
    sessionId: SKILL_LIFECYCLE_SESSION_ID,
    runId: createAuditRunId('skill_lifecycle'),
    event: {
      type: 'skill.lifecycle',
      action: params.action,
      skillName: params.skillName,
      skillId: params.manifest?.id || params.skillName,
      version: params.manifest?.version || null,
      capabilities: params.manifest?.capabilities || [],
      requiredCredentials:
        params.manifest?.requiredCredentials.map((credential) => ({
          id: credential.id,
          required: credential.required,
        })) || [],
      supportedChannels: params.manifest?.supportedChannels || [],
      skillDir: params.skillDir || null,
      source: params.source || null,
      revisionId: params.revisionId || null,
      actor: actorOrDefault(params.actor),
    },
  });
}

function findCatalogSkillByNameOrId(
  nameOrId: string,
): SkillCatalogEntry | null {
  const normalized = nameOrId.trim().toLowerCase();
  return (
    loadSkillCatalog().find(
      (skill) =>
        skill.name.toLowerCase() === normalized ||
        skill.manifest.id.toLowerCase() === normalized,
    ) || null
  );
}

function findInstalledSkillByNameOrId(
  nameOrId: string,
): RuntimeInstalledSkillManifest | null {
  const normalized = nameOrId.trim().toLowerCase();
  return (
    (getRuntimeConfig().skills.installed ?? []).find(
      (entry) =>
        entry.name.toLowerCase() === normalized ||
        entry.id.toLowerCase() === normalized,
    ) || null
  );
}

function findInstalledSkillByManifest(
  manifest: Pick<SkillManifest, 'id' | 'name'>,
): RuntimeInstalledSkillManifest | null {
  return (
    findInstalledSkillByNameOrId(manifest.id) ||
    findInstalledSkillByNameOrId(manifest.name)
  );
}

function assertInstalledSkillForUpgrade(manifest: SkillManifest): void {
  const installed = findInstalledSkillByManifest(manifest);
  if (!installed || installed.status === 'uninstalled') {
    throw new Error(
      `Cannot upgrade skill package "${manifest.name}" because it is not installed. Run skill install <source> first.`,
    );
  }
}

function resolveSkillPackageTarget(nameOrId: string): {
  name: string;
  skillDir: string;
  manifestPath: string;
  manifest: SkillManifest | null;
  source: SkillCatalogEntry['source'] | 'installed';
  installed: RuntimeInstalledSkillManifest | null;
} {
  const catalogSkill = findCatalogSkillByNameOrId(nameOrId);
  if (catalogSkill) {
    const installed = catalogSkill.manifest
      ? findInstalledSkillByManifest(catalogSkill.manifest)
      : findInstalledSkillByNameOrId(catalogSkill.name);
    return {
      name: catalogSkill.name,
      skillDir: catalogSkill.baseDir,
      manifestPath: catalogSkill.filePath,
      manifest: catalogSkill.manifest || null,
      source: catalogSkill.source,
      installed,
    };
  }

  const installed = findInstalledSkillByNameOrId(nameOrId);
  if (installed) {
    return {
      name: installed.name,
      skillDir: installed.skillDir,
      manifestPath: installed.manifestPath,
      manifest: {
        id: installed.id,
        name: installed.name,
        version: installed.version,
        capabilities: installed.capabilities,
        requiredCredentials: installed.requiredCredentials,
        supportedChannels: installed.supportedChannels,
      },
      source: 'installed',
      installed,
    };
  }

  throw new Error(`Unknown skill package: ${nameOrId}`);
}

type SkillPackageInstallCommand = 'install' | 'upgrade';

function assertManagedSkillPackage(skillDir: string, homeDir: string): void {
  const managedDir = resolveManagedCommunitySkillsDir(homeDir);
  if (!pathWithin(managedDir, skillDir)) {
    throw new Error(
      `Refusing to modify non-managed skill package at ${skillDir}. Only skills under ${managedDir} can be changed by lifecycle commands.`,
    );
  }
}

export async function installSkillPackage(
  source: string,
  options: SkillPackageLifecycleOptions = {},
): Promise<SkillPackageInstallResult> {
  return installSkillPackageForCommand(source, options, 'install');
}

async function installSkillPackageForCommand(
  source: string,
  options: SkillPackageLifecycleOptions,
  command: SkillPackageInstallCommand,
): Promise<SkillPackageInstallResult> {
  const homeDir = options.homeDir || DEFAULT_RUNTIME_HOME_DIR;
  let sourceManifest: SkillManifest | null = null;
  const importResult = await importSkill(source, {
    force: options.force,
    homeDir,
    skipGuard: options.skipGuard,
    validateSkillFile: (skillFilePath, skillName) => {
      sourceManifest = parseSkillManifestFile(
        skillFilePath,
        { name: skillName },
        { requireVersion: true },
      );
      if (command === 'upgrade') {
        assertInstalledSkillForUpgrade(sourceManifest);
      }
    },
  });
  assertManagedSkillPackage(importResult.skillDir, homeDir);
  const manifestPath = path.join(importResult.skillDir, 'SKILL.md');
  const manifest =
    sourceManifest ||
    parseSkillManifestFile(
      manifestPath,
      {
        name: importResult.skillName,
      },
      { requireVersion: true },
    );
  const previous = findInstalledSkillByManifest(manifest);
  const action =
    command === 'upgrade'
      ? 'upgrade'
      : importResult.replacedExisting
        ? 'upgrade'
        : 'install';
  const meta = buildLifecycleMeta({
    action,
    actor: options.actor,
    source: importResult.resolvedSource,
  });
  const revisionAssetPath = syncSkillPackageRevisionState({
    skillDir: importResult.skillDir,
    manifest,
    meta,
  });
  updateRuntimeConfig((draft) => {
    updateInstalledSkillManifest(
      draft,
      toRuntimeInstalledSkillManifest({
        manifest,
        previous,
        source: importResult.resolvedSource,
        skillDir: importResult.skillDir,
        manifestPath,
        status: 'enabled',
      }),
    );
  }, meta);
  recordSkillLifecycleAudit({
    action,
    manifest,
    skillName: manifest.name,
    skillDir: importResult.skillDir,
    source: importResult.resolvedSource,
    actor: options.actor,
  });

  return {
    ...importResult,
    action,
    manifest,
    revisionAssetPath,
  };
}

export async function upgradeSkillPackage(
  source: string,
  options: SkillPackageLifecycleOptions = {},
): Promise<SkillPackageInstallResult> {
  return installSkillPackageForCommand(
    source,
    {
      ...options,
      force: true,
    },
    'upgrade',
  );
}

export function setSkillPackageEnabled(params: {
  skillName: string;
  enabled: boolean;
  channelKind?: SkillConfigChannelKind;
  actor?: string;
}): SkillPackageStatusResult {
  const target = resolveSkillPackageTarget(params.skillName);
  const action = params.enabled ? 'enable' : 'disable';
  if (
    !params.channelKind &&
    target.source === 'community' &&
    !target.installed
  ) {
    throw new Error(
      `Cannot ${action} skill package "${target.name}" because it does not have an installed package record.`,
    );
  }
  const meta = buildLifecycleMeta({
    action,
    actor: params.actor,
    source: target.manifestPath,
  });
  updateRuntimeConfig((draft) => {
    draft.skills.installed ??= [];
    setRuntimeSkillScopeEnabled(
      draft,
      target.name,
      params.enabled,
      params.channelKind,
    );
    const installed = draft.skills.installed.find(
      (entry) => entry.id === target.manifest?.id || entry.name === target.name,
    );
    if (installed && !params.channelKind) {
      installed.status = params.enabled ? 'enabled' : 'disabled';
      installed.updatedAt = new Date().toISOString();
    }
  }, meta);
  recordSkillLifecycleAudit({
    action,
    manifest: target.manifest,
    skillName: target.name,
    skillDir: target.skillDir,
    source: target.manifestPath,
    actor: params.actor,
  });

  return {
    action,
    skillName: target.name,
    scope: params.channelKind || 'global',
    manifest: target.manifest,
  };
}

export function uninstallSkillPackage(
  skillName: string,
  options: SkillPackageLifecycleOptions = {},
): SkillPackageUninstallResult {
  const homeDir = options.homeDir || DEFAULT_RUNTIME_HOME_DIR;
  const target = resolveSkillPackageTarget(skillName);
  assertManagedSkillPackage(target.skillDir, homeDir);
  const manifest = fs.existsSync(target.manifestPath)
    ? parseSkillManifestFile(target.manifestPath, { name: target.name })
    : target.manifest;
  const previous = manifest ? findInstalledSkillByNameOrId(manifest.id) : null;
  const meta = buildLifecycleMeta({
    action: 'uninstall',
    actor: options.actor,
    source: target.manifestPath,
  });

  if (manifest && fs.existsSync(target.skillDir)) {
    syncSkillPackageRevisionState({
      skillDir: target.skillDir,
      manifest,
      meta,
    });
  }
  fs.rmSync(target.skillDir, { recursive: true, force: true });
  const revisionAssetPath = removeSkillPackageRevisionState({
    skillDir: target.skillDir,
    meta,
  });
  updateRuntimeConfig((draft) => {
    removeSkillFromDisabledScopes(draft, target.name);
    if (manifest) {
      updateInstalledSkillManifest(
        draft,
        toRuntimeInstalledSkillManifest({
          manifest,
          status: 'uninstalled',
          previous,
          source: previous?.source || target.manifestPath,
          skillDir: target.skillDir,
          manifestPath: target.manifestPath,
        }),
      );
      removeSkillFromDisabledScopes(draft, manifest.id);
      return;
    }
    removeInstalledSkillManifest(draft, target.name);
  }, meta);
  recordSkillLifecycleAudit({
    action: 'uninstall',
    manifest,
    skillName: target.name,
    skillDir: target.skillDir,
    source: target.manifestPath,
    actor: options.actor,
  });

  return {
    action: 'uninstall',
    skillName: target.name,
    skillDir: target.skillDir,
    manifest,
    revisionAssetPath,
  };
}

export function listSkillPackageRevisions(
  skillName: string,
): RuntimeConfigRevisionSummary[] {
  const target = resolveSkillPackageTarget(skillName);
  return listRuntimeAssetRevisions(
    'skill',
    resolveSkillSnapshotAssetPath(target.skillDir),
  );
}

export function rollbackSkillPackage(params: {
  skillName: string;
  revisionId: number;
  actor?: string;
  homeDir?: string;
}): SkillPackageRollbackResult {
  const homeDir = params.homeDir || DEFAULT_RUNTIME_HOME_DIR;
  const target = resolveSkillPackageTarget(params.skillName);
  assertManagedSkillPackage(target.skillDir, homeDir);
  const revisionAssetPath = resolveSkillSnapshotAssetPath(target.skillDir);
  const revision = getRuntimeAssetRevision(
    'skill',
    revisionAssetPath,
    params.revisionId,
  );
  if (!revision) {
    throw new Error(
      `Skill revision ${params.revisionId} was not found for ${target.name}.`,
    );
  }

  const snapshot = parseSkillPackageSnapshot(revision.content);
  restoreSkillPackageSnapshot(target.skillDir, snapshot);
  const previous = findInstalledSkillByNameOrId(snapshot.manifest.id);
  const meta = buildLifecycleMeta({
    action: 'rollback',
    actor: params.actor,
    source: revisionAssetPath,
  });
  syncSkillPackageRevisionState({
    skillDir: target.skillDir,
    manifest: snapshot.manifest,
    meta,
  });
  updateRuntimeConfig((draft) => {
    updateInstalledSkillManifest(
      draft,
      toRuntimeInstalledSkillManifest({
        manifest: snapshot.manifest,
        status: 'enabled',
        previous,
        source: previous?.source || target.manifestPath,
        skillDir: target.skillDir,
        manifestPath: path.join(target.skillDir, 'SKILL.md'),
      }),
    );
  }, meta);
  recordSkillLifecycleAudit({
    action: 'rollback',
    manifest: snapshot.manifest,
    skillName: snapshot.manifest.name,
    skillDir: target.skillDir,
    source: revisionAssetPath,
    revisionId: params.revisionId,
    actor: params.actor,
  });

  return {
    action: 'rollback',
    skillName: snapshot.manifest.name,
    skillDir: target.skillDir,
    revisionId: params.revisionId,
    manifest: snapshot.manifest,
    revisionAssetPath,
  };
}
