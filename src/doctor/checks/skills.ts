import {
  getRuntimeConfig,
  setRuntimeSkillScopeEnabled,
  updateRuntimeConfig,
} from '../../config/runtime-config.js';
import {
  loadSkillCatalog,
  type SkillCatalogEntry,
} from '../../skills/skills.js';
import {
  guardSkillDirectory,
  type SkillGuardScanResult,
} from '../../skills/skills-guard.js';
import type { DiagResult } from '../types.js';
import { makeResult } from '../utils.js';

interface FlaggedSkill {
  skill: SkillCatalogEntry;
  result: SkillGuardScanResult;
}

function formatFlaggedSkill(flagged: FlaggedSkill): string {
  const count = flagged.result.findings.length;
  return `${flagged.skill.name} (${count} finding${count === 1 ? '' : 's'})`;
}

function scanGuardedSkill(skill: SkillCatalogEntry): FlaggedSkill | null {
  const result = guardSkillDirectory({
    skillName: skill.name,
    skillPath: skill.baseDir,
    sourceTag: skill.source,
  }).result;
  if (result.verdict === 'safe') return null;
  return {
    skill,
    result,
  };
}

export async function checkSkills(): Promise<DiagResult[]> {
  const catalog = loadSkillCatalog();
  if (catalog.length === 0) {
    return [
      makeResult('skills', 'Skills', 'ok', 'No loadable skills discovered'),
    ];
  }

  const flagged = catalog
    .map((skill) => scanGuardedSkill(skill))
    .filter(Boolean) as FlaggedSkill[];
  const enabledFlagged = flagged.filter((entry) => entry.skill.enabled);
  const disabledFlagged = flagged.filter((entry) => !entry.skill.enabled);
  const disabledCount = catalog.filter((skill) => !skill.enabled).length;

  if (enabledFlagged.length > 0) {
    const skillNames = enabledFlagged.map((entry) => entry.skill.name);
    const previousDisabled = new Set(
      (getRuntimeConfig().skills?.disabled ?? [])
        .map((name) => String(name).trim())
        .filter(Boolean),
    );
    const summarySkills = enabledFlagged.map(formatFlaggedSkill).join(', ');
    const disabledSuffix =
      disabledFlagged.length > 0
        ? `; ${disabledFlagged.length} flagged skill${disabledFlagged.length === 1 ? '' : 's'} already disabled`
        : '';

    return [
      makeResult(
        'skills',
        'Skills',
        'warn',
        `${enabledFlagged.length} enabled skill${enabledFlagged.length === 1 ? '' : 's'} flagged by the security scanner: ${summarySkills}${disabledSuffix}`,
        {
          summary: `Disable flagged skills: ${skillNames.join(', ')}`,
          apply: async () => {
            updateRuntimeConfig((draft) => {
              for (const skillName of skillNames) {
                setRuntimeSkillScopeEnabled(draft, skillName, false);
              }
            });
          },
          rollback: async () => {
            updateRuntimeConfig((draft) => {
              for (const skillName of skillNames) {
                setRuntimeSkillScopeEnabled(
                  draft,
                  skillName,
                  !previousDisabled.has(skillName),
                );
              }
            });
          },
        },
      ),
    ];
  }

  if (disabledFlagged.length > 0) {
    return [
      makeResult(
        'skills',
        'Skills',
        'ok',
        `${catalog.length} skill${catalog.length === 1 ? '' : 's'} checked; ${disabledFlagged.length} flagged skill${disabledFlagged.length === 1 ? '' : 's'} already disabled`,
      ),
    ];
  }

  return [
    makeResult(
      'skills',
      'Skills',
      'ok',
      `${catalog.length} skill${catalog.length === 1 ? '' : 's'} checked${disabledCount > 0 ? `, ${disabledCount} disabled` : ''}; all loadable skills passed guard checks`,
    ),
  ];
}
