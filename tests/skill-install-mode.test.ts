import { expect, test } from 'vitest';

import { resolveSkillInstallMode } from '../src/skills/skill-install-mode.js';

test('resolves package skill install arguments', () => {
  expect(
    resolveSkillInstallMode(
      ['https://example.com/skills/deal-desk.git', '--force'],
      { commandPrefix: 'skill' },
    ),
  ).toEqual({
    ok: true,
    mode: 'package',
    source: 'https://example.com/skills/deal-desk.git',
    force: true,
    skipSkillScan: false,
  });
});

test('resolves dependency skill install arguments', () => {
  expect(resolveSkillInstallMode(['pdf', 'poppler'], { commandPrefix: 'skill' }))
    .toEqual({
      ok: true,
      mode: 'dependency',
      skillName: 'pdf',
      installId: 'poppler',
    });
});

test('rejects package flags with dependency skill install arguments', () => {
  expect(
    resolveSkillInstallMode(['pdf', 'poppler', '--skip-skill-scan'], {
      commandPrefix: 'skill',
    }),
  ).toEqual({
    ok: false,
    error: 'dependency-flags',
  });
});

test('asks for a dependency when a single argument matches a bundled skill', () => {
  expect(resolveSkillInstallMode(['pdf'], { commandPrefix: 'skill' })).toEqual({
    ok: false,
    error: 'missing-dependency',
  });
});

test('reports a missing skill install target', () => {
  expect(resolveSkillInstallMode([], { commandPrefix: 'skill' })).toEqual({
    ok: false,
    error: 'missing-target',
  });
});
