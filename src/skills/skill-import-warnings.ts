import type { SkillImportResult } from './skills-import.js';

export function buildGuardWarningLines(result: SkillImportResult): string[] {
  if (result.guardSkipped) {
    return [
      `Security scanner skipped for ${result.skillName} because --skip-skill-scan was set.`,
    ];
  }

  if (result.guardOverrideApplied) {
    const findingCount = result.guardFindingsCount ?? 0;
    return [
      `Security scanner reported caution findings for ${result.skillName} (${findingCount} finding${findingCount === 1 ? '' : 's'}); proceeding because --force was set.`,
    ];
  }

  return [];
}
