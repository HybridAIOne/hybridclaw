import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import {
  expandSkillInvocation,
  resolveObservedSkillName,
  resolveSkillInvocationForTurn,
  type Skill,
} from '../src/skills/skills.js';

const tempDirs: string[] = [];

function makeTempSkill(skillName: string): Skill {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-skill-'));
  tempDirs.push(baseDir);
  const filePath = path.join(baseDir, 'SKILL.md');
  fs.writeFileSync(
    filePath,
    [
      '---',
      `name: ${skillName}`,
      'description: Test skill',
      'user-invocable: true',
      '---',
      '',
      `# ${skillName}`,
      '',
      'Use this skill for host-side Apple Music control.',
    ].join('\n'),
    'utf8',
  );
  return {
    name: skillName,
    description: 'Test skill',
    category: 'apple',
    userInvocable: true,
    disableModelInvocation: false,
    always: false,
    requires: { bins: [], env: [] },
    metadata: {
      hybridclaw: {
        tags: [],
        relatedSkills: [],
        install: [],
      },
    },
    filePath,
    baseDir,
    source: 'bundled',
    location: `skills/${skillName}/SKILL.md`,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('does not expand plain-text requests that mention a skill name', () => {
  const appleMusic = makeTempSkill('apple-music');

  const expanded = expandSkillInvocation(
    'Use apple-music skill to skip to next song',
    [appleMusic],
  );

  expect(expanded).toBe('Use apple-music skill to skip to next song');
});

test('expands slash skill invocations into explicit skill instructions', () => {
  const appleMusic = makeTempSkill('apple-music');

  const expanded = expandSkillInvocation('/skill apple-music next track', [
    appleMusic,
  ]);

  expect(expanded).toContain('[Explicit skill invocation]');
  expect(expanded).toContain('Use the "apple-music" skill for this request.');
  expect(expanded).toContain('Skill input: next track');
  expect(expanded).toContain('<skill_instructions>');
});

test('does not expand ordinary prose that merely mentions a skill topic', () => {
  const appleMusic = makeTempSkill('apple-music');

  const expanded = expandSkillInvocation('Skip to next song on Apple Music', [
    appleMusic,
  ]);

  expect(expanded).toBe('Skip to next song on Apple Music');
});

test('expands $skill mentions into explicit skill instructions', () => {
  const appleMusic = makeTempSkill('apple-music');

  const expanded = expandSkillInvocation('$apple-music next track', [
    appleMusic,
  ]);

  expect(expanded).toContain('[Explicit skill invocation]');
  expect(expanded).toContain('Skill input: next track');
});

test('inherits the previous explicit skill for a short follow-up turn', () => {
  const appleMusic = makeTempSkill('apple-music');

  const resolved = resolveSkillInvocationForTurn({
    content: 'Continue and play the next track',
    skills: [appleMusic],
    previousUserContent: '/apple_music queue Phil Collins',
  });

  expect(resolved.inherited).toBe(true);
  expect(resolved.invocation?.skill.name).toBe('apple-music');
  expect(resolved.invocation?.args).toBe('Continue and play the next track');
});

test('does not inherit the previous explicit skill for a new slash-style turn', () => {
  const appleMusic = makeTempSkill('apple-music');

  const resolved = resolveSkillInvocationForTurn({
    content: '/help',
    skills: [appleMusic],
    previousUserContent: '/apple_music queue Phil Collins',
  });

  expect(resolved.inherited).toBe(false);
  expect(resolved.invocation).toBeNull();
});

test('resolves a single implicitly read skill as observed skill use', () => {
  const appleMusic = makeTempSkill('apple-music');

  const observedSkillName = resolveObservedSkillName({
    skills: [appleMusic],
    toolExecutions: [
      {
        name: 'read',
        arguments: '{"path":"skills/apple-music/SKILL.md"}',
        result: 'ok',
        durationMs: 5,
      },
    ],
  });

  expect(observedSkillName).toBe('apple-music');
});

test('prefers a single strongly activated skill over ambiguous skill reads', () => {
  const appleMusic = makeTempSkill('apple-music');
  const pdf = makeTempSkill('pdf');

  const observedSkillName = resolveObservedSkillName({
    skills: [appleMusic, pdf],
    toolExecutions: [
      {
        name: 'read',
        arguments: '{"path":"skills/apple-music/SKILL.md"}',
        result: 'ok',
        durationMs: 5,
      },
      {
        name: 'read',
        arguments: '{"path":"skills/pdf/SKILL.md"}',
        result: 'ok',
        durationMs: 5,
      },
      {
        name: 'bash',
        arguments:
          '{"cmd":"bash skills/apple-music/scripts/search.sh \\"Phil Collins\\""}',
        result: 'ok',
        durationMs: 12,
      },
    ],
  });

  expect(observedSkillName).toBe('apple-music');
});

test('leaves implicit skill observations unattributed when multiple skills were only explored', () => {
  const appleMusic = makeTempSkill('apple-music');
  const pdf = makeTempSkill('pdf');

  const observedSkillName = resolveObservedSkillName({
    skills: [appleMusic, pdf],
    toolExecutions: [
      {
        name: 'read',
        arguments: '{"path":"skills/apple-music/SKILL.md"}',
        result: 'ok',
        durationMs: 5,
      },
      {
        name: 'read',
        arguments: '{"path":"skills/pdf/SKILL.md"}',
        result: 'ok',
        durationMs: 5,
      },
    ],
  });

  expect(observedSkillName).toBeNull();
});
