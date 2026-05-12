import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  hasBinary,
  loadSkillCatalog,
  type SkillCatalogEntry,
  type SkillInstallSpec,
} from './skills.js';

export interface SkillInstallResult {
  ok: boolean;
  message: string;
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface SkillInstallSelection {
  skill: SkillCatalogEntry;
  spec: SkillInstallSpec;
  installId: string;
}

const SAFE_BREW_FORMULA =
  /^[a-z0-9][a-z0-9+._@-]*(\/[a-z0-9][a-z0-9+._@-]*){0,2}$/;
const SAFE_NODE_PACKAGE =
  /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(@[a-z0-9^~>=<.*|-]+)?$/;
const SAFE_GO_MODULE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*@[a-z0-9v._-]+$/;
const SAFE_UV_PACKAGE =
  /^[a-z0-9][a-z0-9._-]*(\[[a-z0-9,._-]+\])?(([><=!~]=?|===?)[a-z0-9.*_-]+)?$/i;
const SKILL_DOWNLOADS_DIR = path.resolve(
  os.homedir(),
  '.hybridclaw',
  'downloads',
);

function normalizeSkillLookup(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

function createInstallFailure(params: {
  message: string;
  stdout?: string;
  stderr?: string;
  code?: number | null;
}): SkillInstallResult {
  return {
    ok: false,
    message: params.message,
    stdout: params.stdout?.trim() ?? '',
    stderr: params.stderr?.trim() ?? '',
    code: params.code ?? null,
  };
}

function createInstallSuccess(params: {
  message: string;
  stdout?: string;
  stderr?: string;
  code?: number | null;
}): SkillInstallResult {
  return {
    ok: true,
    message: params.message,
    stdout: params.stdout?.trim() ?? '',
    stderr: params.stderr?.trim() ?? '',
    code: params.code ?? 0,
  };
}

function assertSafeInstallerValue(
  value: string,
  kind: string,
  pattern: RegExp,
): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('-')) {
    return `${kind} value is empty or starts with a dash`;
  }
  if (!pattern.test(trimmed)) {
    return `${kind} value contains invalid characters: ${trimmed}`;
  }
  return null;
}

function resolveBrewExecutable(): string | null {
  if (hasBinary('brew')) return 'brew';

  for (const candidate of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function isSafeDownloadUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).protocol === 'https:';
  } catch {
    return false;
  }
}

function resolveDownloadTargetPath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(SKILL_DOWNLOADS_DIR, trimmed);
  if (
    resolved === SKILL_DOWNLOADS_DIR ||
    !resolved.startsWith(`${SKILL_DOWNLOADS_DIR}${path.sep}`)
  ) {
    return null;
  }
  return resolved;
}

export function resolveSkillInstallId(
  spec: SkillInstallSpec,
  index: number,
): string {
  return (spec.id || `${spec.kind}-${index + 1}`).trim();
}

export function findSkillCatalogEntry(
  rawName: string,
): SkillCatalogEntry | null {
  const target = rawName.trim().toLowerCase();
  const normalizedTarget = normalizeSkillLookup(rawName);
  return (
    loadSkillCatalog().find((skill) => {
      if (skill.name.toLowerCase() === target) return true;
      return normalizeSkillLookup(skill.name) === normalizedTarget;
    }) || null
  );
}

export function resolveSkillInstallSelection(params: {
  skillName: string;
  installId?: string;
}): SkillInstallSelection | { error: string } {
  const skill = findSkillCatalogEntry(params.skillName);
  if (!skill) {
    return { error: `Unknown skill: ${params.skillName}` };
  }

  const installSpecs = skill.metadata.hybridclaw.install || [];
  if (installSpecs.length === 0) {
    return {
      error: `Skill "${skill.name}" does not declare install metadata.`,
    };
  }

  const normalizedInstallId = params.installId?.trim();
  if (!normalizedInstallId) {
    const formatted = installSpecs
      .map((spec, index) => {
        const installId = resolveSkillInstallId(spec, index);
        const label = spec.label ? ` — ${spec.label}` : '';
        return `${installId} (${spec.kind})${label}\n  retry: skill install ${skill.name} ${installId}`;
      })
      .join('\n');
    return {
      error: `Missing dependency id for "${skill.name}". Specify one of:\n${formatted}`,
    };
  }

  const matched = installSpecs.find(
    (spec, index) => resolveSkillInstallId(spec, index) === normalizedInstallId,
  );
  if (!matched) {
    const availableIds = installSpecs
      .map((spec, index) => resolveSkillInstallId(spec, index))
      .join(', ');
    return {
      error: `Install id "${normalizedInstallId}" not found for "${skill.name}". Available ids: ${availableIds}`,
    };
  }

  return {
    skill,
    spec: matched,
    installId: normalizedInstallId,
  };
}

function buildInstallCommand(spec: SkillInstallSpec): string[] | null {
  switch (spec.kind) {
    case 'brew':
      return spec.formula ? ['brew', 'install', spec.formula] : null;
    case 'uv':
      return spec.package ? ['uv', 'tool', 'install', spec.package] : null;
    case 'npm':
    case 'node':
      return spec.package
        ? ['npm', 'install', '-g', '--ignore-scripts', spec.package]
        : null;
    case 'go':
      return spec.module ? ['go', 'install', spec.module] : null;
    case 'download':
      return null;
    default:
      return null;
  }
}

function validateInstallSpec(spec: SkillInstallSpec): string | null {
  switch (spec.kind) {
    case 'brew':
      if (!spec.formula) return 'missing formula';
      return assertSafeInstallerValue(
        spec.formula,
        'brew formula',
        SAFE_BREW_FORMULA,
      );
    case 'uv':
      if (!spec.package) return 'missing package';
      return assertSafeInstallerValue(
        spec.package,
        'uv package',
        SAFE_UV_PACKAGE,
      );
    case 'npm':
    case 'node':
      if (!spec.package) return 'missing package';
      return assertSafeInstallerValue(
        spec.package,
        'node package',
        SAFE_NODE_PACKAGE,
      );
    case 'go':
      if (!spec.module) return 'missing module';
      return assertSafeInstallerValue(spec.module, 'go module', SAFE_GO_MODULE);
    case 'download': {
      if (!spec.url || !spec.path) return 'missing url or path';
      if (!isSafeDownloadUrl(spec.url)) {
        return 'download url must use https';
      }
      if (!resolveDownloadTargetPath(spec.path)) {
        return 'download path must be inside ~/.hybridclaw/downloads';
      }
      return null;
    }
    default:
      return 'unsupported install kind';
  }
}

async function runCommand(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', (err) => {
      resolve({
        code: null,
        stdout,
        stderr: err instanceof Error ? err.message : String(err),
      });
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function prependPathEnv(binDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const currentPath = env.PATH || '';
  env.PATH = currentPath ? `${binDir}${path.delimiter}${currentPath}` : binDir;
  return env;
}

async function resolveBrewBinDir(brewExe: string): Promise<string | undefined> {
  const prefixResult = await runCommand([brewExe, '--prefix']);
  if (prefixResult.code === 0) {
    const prefix = prefixResult.stdout.trim();
    if (prefix) return path.join(prefix, 'bin');
  }

  const envPrefix = process.env.HOMEBREW_PREFIX?.trim();
  if (envPrefix) return path.join(envPrefix, 'bin');

  for (const candidate of ['/opt/homebrew/bin', '/usr/local/bin']) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return undefined;
}

async function ensureUvInstalled(): Promise<
  | {
      env?: NodeJS.ProcessEnv;
    }
  | SkillInstallResult
> {
  if (hasBinary('uv')) {
    return {};
  }

  const brewExe = resolveBrewExecutable();
  if (!brewExe) {
    return createInstallFailure({
      message:
        'uv not installed — install Homebrew or install uv manually: https://docs.astral.sh/uv/getting-started/installation/',
    });
  }

  const brewResult = await runCommand([brewExe, 'install', 'uv']);
  if (brewResult.code !== 0) {
    return createInstallFailure({
      message: 'Failed to install uv (brew)',
      stdout: brewResult.stdout,
      stderr: brewResult.stderr,
      code: brewResult.code,
    });
  }

  const brewBinDir = await resolveBrewBinDir(brewExe);
  if (!brewBinDir) return {};

  return {
    env: prependPathEnv(brewBinDir),
  };
}

async function runDownloadInstall(
  spec: SkillInstallSpec,
): Promise<SkillInstallResult> {
  const targetPath = resolveDownloadTargetPath(spec.path || '');
  if (!targetPath) {
    return createInstallFailure({
      message: 'download path must be inside ~/.hybridclaw/downloads',
    });
  }
  try {
    const response = await fetch(spec.url || '');
    if (!response.ok) {
      return createInstallFailure({
        message: `Download failed with HTTP ${response.status}`,
        code: response.status,
      });
    }

    const body = Buffer.from(await response.arrayBuffer());
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, body);
    if (spec.chmod) {
      const parsedMode = Number.parseInt(spec.chmod, 8);
      if (Number.isFinite(parsedMode)) {
        fs.chmodSync(targetPath, parsedMode);
      }
    }

    return createInstallSuccess({
      message: `Downloaded to ${targetPath}`,
    });
  } catch (err) {
    return createInstallFailure({
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function validateInstalledBins(spec: SkillInstallSpec): string[] {
  return (spec.bins || []).filter((bin) => !hasBinary(bin));
}

export async function installSkillDependency(params: {
  skillName: string;
  installId?: string;
}): Promise<SkillInstallResult> {
  const selection = resolveSkillInstallSelection(params);
  if ('error' in selection) {
    return createInstallFailure({
      message: selection.error,
    });
  }

  const validationError = validateInstallSpec(selection.spec);
  if (validationError) {
    return createInstallFailure({
      message: `Invalid install spec for "${selection.skill.name}" (${selection.installId}): ${validationError}`,
    });
  }

  if (selection.spec.kind === 'download') {
    const result = await runDownloadInstall(selection.spec);
    if (!result.ok) return result;
    const missingBins = validateInstalledBins(selection.spec);
    if (missingBins.length > 0) {
      return createInstallFailure({
        message: `Install completed but expected binaries are still missing: ${missingBins.join(', ')}`,
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code,
      });
    }
    return result;
  }

  let env: NodeJS.ProcessEnv | undefined;
  if (selection.spec.kind === 'uv') {
    const uvSetup = await ensureUvInstalled();
    if ('ok' in uvSetup) return uvSetup;
    env = uvSetup.env;
  }

  const argv = buildInstallCommand(selection.spec);
  if (!argv) {
    return createInstallFailure({
      message: `Unsupported install spec for "${selection.skill.name}" (${selection.installId})`,
    });
  }

  const result = await runCommand(argv, env);
  if (result.code !== 0) {
    return createInstallFailure({
      message: `Install command failed: ${argv.join(' ')}`,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
    });
  }

  const missingBins = validateInstalledBins(selection.spec);
  if (missingBins.length > 0) {
    return createInstallFailure({
      message: `Install completed but expected binaries are still missing: ${missingBins.join(', ')}`,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
    });
  }

  return createInstallSuccess({
    message: `Installed ${selection.skill.name} via ${selection.installId}`,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
  });
}

export async function setupSkillDependencies(params: {
  skillName: string;
}): Promise<SkillInstallResult> {
  const skill = findSkillCatalogEntry(params.skillName);
  if (!skill) {
    return createInstallFailure({
      message: `Unknown skill: ${params.skillName}`,
    });
  }

  const installSpecs = skill.metadata.hybridclaw.install || [];
  if (installSpecs.length === 0) {
    return createInstallFailure({
      message: `Skill "${skill.name}" does not declare install metadata.`,
    });
  }

  const completed: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  for (const [index, spec] of installSpecs.entries()) {
    const installId = resolveSkillInstallId(spec, index);
    const result = await installSkillDependency({
      skillName: skill.name,
      installId,
    });
    if (result.stdout) stdout.push(`[${installId}]\n${result.stdout}`);
    if (result.stderr) stderr.push(`[${installId}]\n${result.stderr}`);
    if (!result.ok) {
      return createInstallFailure({
        message: [
          `Skill setup failed for "${skill.name}" at dependency "${installId}".`,
          completed.length > 0 ? `Completed: ${completed.join(', ')}` : '',
          `Failure: ${result.message}`,
        ]
          .filter(Boolean)
          .join('\n'),
        stdout: stdout.join('\n\n'),
        stderr: stderr.join('\n\n'),
        code: result.code,
      });
    }
    completed.push(installId);
  }

  return createInstallSuccess({
    message: `Set up ${skill.name}: installed ${completed.join(', ')}`,
    stdout: stdout.join('\n\n'),
    stderr: stderr.join('\n\n'),
  });
}
