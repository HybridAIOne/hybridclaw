import { spawn } from 'node:child_process';
import fs from 'node:fs';
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

function normalizeSkillLookup(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
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
  if (!skill) return { error: `Unknown skill: ${params.skillName}` };

  const installSpecs = skill.metadata.hybridclaw.install || [];
  if (installSpecs.length === 0) {
    return {
      error: `Skill "${skill.name}" does not declare install metadata.`,
    };
  }

  if (params.installId?.trim()) {
    const normalizedInstallId = params.installId.trim();
    const matched = installSpecs.find(
      (spec, index) =>
        resolveSkillInstallId(spec, index) === normalizedInstallId,
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

  if (installSpecs.length > 1) {
    const formatted = installSpecs
      .map((spec, index) => {
        const installId = resolveSkillInstallId(spec, index);
        const label = spec.label ? ` — ${spec.label}` : '';
        return `${installId} (${spec.kind})${label}`;
      })
      .join('\n');
    return {
      error: `Skill "${skill.name}" has multiple install options. Specify one of:\n${formatted}`,
    };
  }

  return {
    skill,
    spec: installSpecs[0],
    installId: resolveSkillInstallId(installSpecs[0], 0),
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
      return spec.formula ? null : 'missing formula';
    case 'uv':
      return spec.package ? null : 'missing package';
    case 'npm':
    case 'node':
      return spec.package ? null : 'missing package';
    case 'go':
      return spec.module ? null : 'missing module';
    case 'download':
      return spec.url && spec.path ? null : 'missing url or path';
    default:
      return 'unsupported install kind';
  }
}

async function runCommand(argv: string[]): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
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

async function runDownloadInstall(
  spec: SkillInstallSpec,
): Promise<SkillInstallResult> {
  const targetPath = path.resolve(spec.path || '');
  try {
    const response = await fetch(spec.url || '');
    if (!response.ok) {
      return {
        ok: false,
        message: `Download failed with HTTP ${response.status}`,
        stdout: '',
        stderr: '',
        code: response.status,
      };
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

    return {
      ok: true,
      message: `Downloaded to ${targetPath}`,
      stdout: '',
      stderr: '',
      code: 0,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      stdout: '',
      stderr: '',
      code: null,
    };
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
    return {
      ok: false,
      message: selection.error,
      stdout: '',
      stderr: '',
      code: null,
    };
  }

  const validationError = validateInstallSpec(selection.spec);
  if (validationError) {
    return {
      ok: false,
      message: `Invalid install spec for "${selection.skill.name}" (${selection.installId}): ${validationError}`,
      stdout: '',
      stderr: '',
      code: null,
    };
  }

  if (selection.spec.kind === 'download') {
    const result = await runDownloadInstall(selection.spec);
    if (!result.ok) return result;
    const missingBins = validateInstalledBins(selection.spec);
    if (missingBins.length > 0) {
      return {
        ok: false,
        message: `Install completed but expected binaries are still missing: ${missingBins.join(', ')}`,
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code,
      };
    }
    return result;
  }

  const argv = buildInstallCommand(selection.spec);
  if (!argv) {
    return {
      ok: false,
      message: `Unsupported install spec for "${selection.skill.name}" (${selection.installId})`,
      stdout: '',
      stderr: '',
      code: null,
    };
  }

  const result = await runCommand(argv);
  if (result.code !== 0) {
    return {
      ok: false,
      message: `Install command failed: ${argv.join(' ')}`,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      code: result.code,
    };
  }

  const missingBins = validateInstalledBins(selection.spec);
  if (missingBins.length > 0) {
    return {
      ok: false,
      message: `Install completed but expected binaries are still missing: ${missingBins.join(', ')}`,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      code: result.code,
    };
  }

  return {
    ok: true,
    message: `Installed ${selection.skill.name} via ${selection.installId}`,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    code: result.code,
  };
}
