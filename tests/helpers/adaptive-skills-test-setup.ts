import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

const DEFAULT_SKILL_BODY = `---
name: demo-skill
description: Demo skill for tests
---
Follow the user's request carefully.
Keep the response concise.
`;

export interface AdaptiveSkillsTestContext {
  homeDir: string;
  dbPath: string;
  skillName: string;
  skillDir: string;
  skillFilePath: string;
  dbModule: typeof import('../../src/memory/db.ts');
  runtimeConfigModule: typeof import('../../src/config/runtime-config.ts');
  cleanup: () => void;
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

export async function createAdaptiveSkillsTestContext(options?: {
  skillName?: string;
  skillBody?: string;
}): Promise<AdaptiveSkillsTestContext> {
  const originalHome = process.env.HOME;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-skill-'));
  process.env.HOME = homeDir;
  vi.resetModules();

  const dbPath = path.join(homeDir, 'data', 'test.db');
  const extraSkillsDir = path.join(homeDir, 'extra-skills');
  const skillName = options?.skillName || 'demo-skill';
  const skillDir = path.join(extraSkillsDir, skillName);
  const skillFilePath = path.join(skillDir, 'SKILL.md');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    skillFilePath,
    options?.skillBody || DEFAULT_SKILL_BODY,
    'utf-8',
  );

  const dbModule = await import('../../src/memory/db.ts');
  const runtimeConfigModule = await import(
    '../../src/config/runtime-config.ts'
  );
  dbModule.initDatabase({ quiet: true, dbPath });

  runtimeConfigModule.updateRuntimeConfig((draft) => {
    draft.skills.extraDirs = [extraSkillsDir];
    draft.skills.disabled = [];
    draft.adaptiveSkills.enabled = false;
    draft.adaptiveSkills.observationEnabled = true;
    draft.adaptiveSkills.inspectionIntervalMs = 0;
    draft.adaptiveSkills.observationRetentionDays = 30;
    draft.adaptiveSkills.trailingWindowHours = 24;
    draft.adaptiveSkills.minExecutionsForInspection = 1;
    draft.adaptiveSkills.degradationSuccessRateThreshold = 0.6;
    draft.adaptiveSkills.degradationToolBreakageThreshold = 0.3;
    draft.adaptiveSkills.autoApplyEnabled = false;
    draft.adaptiveSkills.evaluationRunsBeforeRollback = 3;
    draft.adaptiveSkills.rollbackImprovementThreshold = 0.05;
  });

  return {
    homeDir,
    dbPath,
    skillName,
    skillDir,
    skillFilePath,
    dbModule,
    runtimeConfigModule,
    cleanup: () => {
      vi.restoreAllMocks();
      vi.resetModules();
      restoreEnvVar('HOME', originalHome);
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}
