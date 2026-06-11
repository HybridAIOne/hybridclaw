import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { parseSkillManifestFromMarkdown } from '../src/skills/skill-manifest.js';

const skillDir = path.join(process.cwd(), 'skills', 'human-distill');
const skillPath = path.join(skillDir, 'SKILL.md');

test('human-distill skill manifest parses with required frontmatter', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');
  const manifest = parseSkillManifestFromMarkdown(skill, {
    name: 'human-distill',
  });
  expect(manifest.id).toBe('human-distill');
  expect(manifest.name).toBe('human-distill');
  expect(skill).toMatch(/^user-invocable: true$/m);
  expect(skill).toMatch(/category: productivity/);
});

test('human-distill skill enforces the consent and citation invariants', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');
  expect(skill).toContain('Consent first.');
  expect(skill).toContain('Never run `coworker consent record` on your own');
  expect(skill).toContain('Evidence or nothing.');
  expect(skill).toContain('extraction.json');
  expect(skill).toContain('hybridclaw coworker distill');
  expect(skill).toContain('coworker correct');
  // Forget is operator-only; the skill must list it as forbidden.
  expect(skill).toMatch(/Red \(never\):[\s\S]*coworker forget/);
});

test('human-distill references exist and are linked from SKILL.md', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');
  for (const reference of [
    'six-dimensions.md',
    'extraction-contract.md',
    'interview-protocol.md',
    'mirroring.md',
  ]) {
    expect(skill).toContain(`references/${reference}`);
    expect(fs.existsSync(path.join(skillDir, 'references', reference))).toBe(
      true,
    );
  }
});

test('extraction contract reference documents the validation rules', () => {
  const contract = fs.readFileSync(
    path.join(skillDir, 'references', 'extraction-contract.md'),
    'utf-8',
  );
  expect(contract).toContain('"version": 1');
  expect(contract).toContain('conflictsWith');
  expect(contract).toContain('openQuestions');
  expect(contract).toContain('flagged');
});
