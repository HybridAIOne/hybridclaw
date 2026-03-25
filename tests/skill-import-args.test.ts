import { expect, test } from 'vitest';

import { parseSkillImportArgs } from '../src/skills/skill-import-args.js';

test('parses skill import args with force and scan flags', () => {
  expect(
    parseSkillImportArgs(
      ['--force', '--skip-skill-scan', '  anthropics/skills/skills/brand-guidelines  '],
      {
        commandPrefix: 'hybridclaw skill',
        commandName: 'import',
      },
    ),
  ).toEqual({
    source: 'anthropics/skills/skills/brand-guidelines',
    force: true,
    skipSkillScan: true,
  });
});

test('rejects --force for sync and trims unknown values', () => {
  expect(() =>
    parseSkillImportArgs(['--force', 'official/datalion'], {
      commandPrefix: 'skill',
      commandName: 'sync',
      allowForce: false,
    }),
  ).toThrow('Unknown option for `skill sync`: --force. Use `skill sync [--skip-skill-scan] <source>`.');

  expect(
    parseSkillImportArgs([0], {
      commandPrefix: 'skill',
      commandName: 'sync',
      allowForce: false,
    }),
  ).toEqual({
    source: '0',
    force: false,
    skipSkillScan: false,
  });
});
