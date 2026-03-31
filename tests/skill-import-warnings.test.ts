import { expect, test } from 'vitest';

import { buildGuardWarningLines } from '../src/skills/skill-import-warnings.js';

test('buildGuardWarningLines returns skip warning when guard was bypassed', () => {
  expect(
    buildGuardWarningLines({
      skillName: 'datalion',
      skillDir: '/tmp/.hybridclaw/skills/datalion',
      source: 'official/datalion',
      resolvedSource: 'official/datalion',
      replacedExisting: true,
      filesImported: 2,
      guardSkipped: true,
    }),
  ).toEqual([
    'Security scanner skipped for datalion because --skip-skill-scan was set.',
  ]);
});

test('buildGuardWarningLines returns caution override warning', () => {
  expect(
    buildGuardWarningLines({
      skillName: 'datalion',
      skillDir: '/tmp/.hybridclaw/skills/datalion',
      source: 'official/datalion',
      resolvedSource: 'official/datalion',
      replacedExisting: true,
      filesImported: 2,
      guardOverrideApplied: true,
      guardFindingsCount: 2,
    }),
  ).toEqual([
    'Security scanner reported caution findings for datalion (2 findings); proceeding because --force was set.',
  ]);
});

test('buildGuardWarningLines returns an empty list with no guard warnings', () => {
  expect(
    buildGuardWarningLines({
      skillName: 'datalion',
      skillDir: '/tmp/.hybridclaw/skills/datalion',
      source: 'official/datalion',
      resolvedSource: 'official/datalion',
      replacedExisting: true,
      filesImported: 2,
    }),
  ).toEqual([]);
});
