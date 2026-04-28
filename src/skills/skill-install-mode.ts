import {
  type ParsedSkillImportArgs,
  parseSkillImportArgs,
} from './skill-import-args.js';
import { findSkillCatalogEntry } from './skills-install.js';

export type SkillInstallModeResolution =
  | ({ ok: true; mode: 'package' } & ParsedSkillImportArgs)
  | {
      ok: true;
      mode: 'dependency';
      skillName: string;
      installId: string;
    }
  | {
      ok: false;
      error: 'missing-target' | 'missing-dependency';
    };

function normalizeInstallArg(raw: unknown): string {
  return String(raw ?? '').trim();
}

export function resolveSkillInstallMode(
  args: readonly unknown[],
  options: { commandPrefix: string },
): SkillInstallModeResolution {
  const skillName = normalizeInstallArg(args[0]);
  const installId = normalizeInstallArg(args[1]);
  const hasPackageInstallFlag = args
    .map(normalizeInstallArg)
    .some((arg) => arg === '--force' || arg === '--skip-skill-scan');

  if (!skillName) {
    return { ok: false, error: 'missing-target' };
  }

  if (!installId || hasPackageInstallFlag) {
    if (
      !installId &&
      !hasPackageInstallFlag &&
      findSkillCatalogEntry(skillName)
    ) {
      return { ok: false, error: 'missing-dependency' };
    }
    return {
      ok: true,
      mode: 'package',
      ...parseSkillImportArgs(args, {
        commandPrefix: options.commandPrefix,
        commandName: 'install',
        allowForce: true,
      }),
    };
  }

  return {
    ok: true,
    mode: 'dependency',
    skillName,
    installId,
  };
}
