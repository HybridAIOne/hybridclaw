import {
  getRuntimeConfig,
  setRuntimeSkillScopeEnabled,
  updateRuntimeConfig,
} from '../../config/runtime-config.js';
import {
  getSessionCount,
  getSkillObservationSummary,
} from '../../memory/db.js';
import {
  loadSkillCatalog,
  type SkillCatalogEntry,
} from '../../skills/skills.js';
import {
  guardSkillDirectory,
  type SkillGuardScanResult,
} from '../../skills/skills-guard.js';
import type { DiagResult } from '../types.js';
import {
  buildUnusedWindowStart,
  DEFAULT_UNUSED_WINDOW_DAYS,
  formatDateOrNever,
  makeResult,
} from '../utils.js';

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

function buildUnusedSkillsResult(
  catalog: SkillCatalogEntry[],
): DiagResult | null {
  const enabledSkills = catalog.filter((skill) => skill.enabled);
  if (enabledSkills.length === 0) return null;

  const summaries = getSkillObservationSummary();
  if (summaries.length === 0 && getSessionCount() === 0) return null;

  const cutoff = buildUnusedWindowStart();
  const usageBySkill = new Map(
    summaries.map((summary) => [summary.skill_name, summary]),
  );
  const unused = enabledSkills
    .filter(
      (skill) =>
        (usageBySkill.get(skill.name)?.last_observed_at || '') < cutoff,
    )
    .map((skill) => ({
      name: skill.name,
      lastObservedAt: usageBySkill.get(skill.name)?.last_observed_at || null,
    }));

  if (unused.length === 0) return null;

  const previousDisabled = new Set(
    (getRuntimeConfig().skills?.disabled ?? [])
      .map((name) => String(name).trim())
      .filter(Boolean),
  );
  const skillNames = unused.map((entry) => entry.name);
  return makeResult(
    'skills',
    'Unused skills',
    'warn',
    `${unused.length} enabled skill${unused.length === 1 ? '' : 's'} unused in the last ${DEFAULT_UNUSED_WINDOW_DAYS} days: ${unused
      .map(
        (entry) =>
          `${entry.name} (last used ${formatDateOrNever(entry.lastObservedAt)})`,
      )
      .join(', ')}. Re-enable with \`hybridclaw skill enable <name>\`.`,
    {
      summary: `Disable unused skills: ${skillNames.join(', ')}`,
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
  );
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

    const results = [
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
    const unusedSkills = buildUnusedSkillsResult(catalog);
    if (unusedSkills) results.push(unusedSkills);
    return results;
  }

  if (disabledFlagged.length > 0) {
    const results = [
      makeResult(
        'skills',
        'Skills',
        'ok',
        `${catalog.length} skill${catalog.length === 1 ? '' : 's'} checked; ${disabledFlagged.length} flagged skill${disabledFlagged.length === 1 ? '' : 's'} already disabled`,
      ),
    ];
    const unusedSkills = buildUnusedSkillsResult(catalog);
    if (unusedSkills) results.push(unusedSkills);
    return results;
  }

  const results = [
    makeResult(
      'skills',
      'Skills',
      'ok',
      `${catalog.length} skill${catalog.length === 1 ? '' : 's'} checked${disabledCount > 0 ? `, ${disabledCount} disabled` : ''}; all loadable skills passed guard checks`,
    ),
  ];
  const unusedSkills = buildUnusedSkillsResult(catalog);
  if (unusedSkills) results.push(unusedSkills);
  return results;
}
