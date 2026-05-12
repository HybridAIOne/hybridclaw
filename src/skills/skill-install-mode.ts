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
      error: 'missing-target' | 'missing-dependency' | 'dependency-flags';
    };

function normalizeInstallArg(raw: unknown): string {
  return String(raw ?? '').trim();
}

export function resolveSkillInstallMode(
  args: readonly unknown[],
  options: { commandPrefix: string },
): SkillInstallModeResolution {
  const normalizedArgs = args.map(normalizeInstallArg);
  const skillName = normalizedArgs[0] || '';
  const secondArg = normalizedArgs[1] || '';
  const installId = secondArg && !secondArg.startsWith('--') ? secondArg : '';
  const hasPackageInstallFlag = normalizedArgs.some(
    (arg) => arg === '--force' || arg === '--skip-skill-scan',
  );

  if (!skillName) {
    return { ok: false, error: 'missing-target' };
  }

  if (installId) {
    if (hasPackageInstallFlag) {
      return { ok: false, error: 'dependency-flags' };
    }
    return {
      ok: true,
      mode: 'dependency',
      skillName,
      installId,
    };
  }

  if (!hasPackageInstallFlag && findSkillCatalogEntry(skillName)) {
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
