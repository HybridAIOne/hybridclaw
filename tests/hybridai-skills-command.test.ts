import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  type HybridaiSkillFixture,
  harvestHybridaiSkillsFixtures,
  readHybridaiSkillsFixtures,
  writeHybridaiSkillsFixtures,
} from '../src/evals/hybridai-skills-command.js';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-hybridai-skills-');

function writeDoc(dir: string, filename: string, body: string): string {
  const target = path.join(dir, filename);
  fs.writeFileSync(target, body, 'utf8');
  return target;
}

const SAMPLE_DOC = [
  '---',
  'title: Development Skills',
  '---',
  '',
  '# Development Skills',
  '',
  '## code-review',
  '',
  'Body text.',
  '',
  '> 💡 **Tips & Tricks**',
  '>',
  '> Reviews by severity.',
  '',
  '> 🎯 **Try it yourself**',
  '>',
  '> `Review the diff on my current branch for bugs and security issues`',
  '>',
  '> `Review PR #42 and list findings by severity`',
  '>',
  '> **Conversation flow:**',
  '>',
  '> `1. Review the diff on my current branch`',
  '> `2. Show me the exact code path for the auth issue you flagged`',
  '',
  '---',
  '',
  '## apple-music',
  '',
  '> 🎯 **Try it yourself**',
  '>',
  '> `Skip to the next track`',
  '>',
  '> `Use the apple-music skill to play my Focus playlist`',
  '',
  '---',
  '',
  '## code-simplification',
  '',
  '*(Model-invoked, not user-invocable)*',
  '',
  'Body only. No Try it yourself block.',
  '',
].join('\n');

describe('harvestHybridaiSkillsFixtures', () => {
  test('extracts try-it-yourself prompts and attaches them to the right skill', () => {
    const docsRoot = makeTempDir();
    writeDoc(docsRoot, 'development.md', SAMPLE_DOC);

    const set = harvestHybridaiSkillsFixtures(docsRoot);

    const codeReviewTryIt = set.fixtures.filter(
      (fixture) => fixture.skill === 'code-review' && fixture.kind === 'try-it',
    );
    expect(codeReviewTryIt.map((fixture) => fixture.prompt)).toEqual([
      'Review the diff on my current branch for bugs and security issues',
      'Review PR #42 and list findings by severity',
    ]);
  });

  test('splits conversation-flow turns into separate fixtures with the same conversation id', () => {
    const docsRoot = makeTempDir();
    writeDoc(docsRoot, 'development.md', SAMPLE_DOC);

    const set = harvestHybridaiSkillsFixtures(docsRoot);
    const conversation = set.fixtures.filter(
      (fixture) =>
        fixture.skill === 'code-review' && fixture.kind === 'conversation',
    );
    expect(conversation).toHaveLength(2);
    expect(conversation[0].turnIndex).toBe(1);
    expect(conversation[1].turnIndex).toBe(2);
    expect(conversation[0].conversationId).toBe(conversation[1].conversationId);
    expect(conversation[0].prompt).toBe('Review the diff on my current branch');
  });

  test('marks prompts that name the skill as explicit and others as implicit', () => {
    const docsRoot = makeTempDir();
    writeDoc(docsRoot, 'apple.md', SAMPLE_DOC);

    const set = harvestHybridaiSkillsFixtures(docsRoot);
    const appleMusic = set.fixtures.filter(
      (fixture) => fixture.skill === 'apple-music',
    );
    const modes = appleMusic.map((fixture) => fixture.mode);
    expect(modes).toContain('explicit');
    expect(modes).toContain('implicit');
    const explicit = appleMusic.find((fixture) => fixture.mode === 'explicit');
    expect(explicit?.prompt).toContain('apple-music skill');
  });

  test('skips sections without a try-it block and excludes README', () => {
    const docsRoot = makeTempDir();
    writeDoc(docsRoot, 'development.md', SAMPLE_DOC);
    writeDoc(
      docsRoot,
      'README.md',
      '## decoy-skill\n\n> 🎯 **Try it yourself**\n>\n> `Should not be harvested`\n',
    );

    const set = harvestHybridaiSkillsFixtures(docsRoot);
    const skills = new Set(set.fixtures.map((fixture) => fixture.skill));
    expect(skills.has('code-simplification')).toBe(false);
    expect(skills.has('decoy-skill')).toBe(false);
    expect(set.sourceFiles).toEqual(['development.md']);
  });

  test('returns an empty set when the docs directory is missing', () => {
    const docsRoot = path.join(makeTempDir(), 'does-not-exist');
    const set = harvestHybridaiSkillsFixtures(docsRoot);
    expect(set.fixtures).toEqual([]);
    expect(set.sourceFiles).toEqual([]);
  });
});

describe('fixture store round-trip', () => {
  test('writes JSONL and reads it back with stable ids', () => {
    const docsRoot = makeTempDir();
    writeDoc(docsRoot, 'development.md', SAMPLE_DOC);
    const original = harvestHybridaiSkillsFixtures(docsRoot);

    const dataDir = makeTempDir();
    const paths = writeHybridaiSkillsFixtures(dataDir, original);
    expect(fs.existsSync(paths.fixturesPath)).toBe(true);
    expect(fs.existsSync(paths.metaPath)).toBe(true);

    const reloaded = readHybridaiSkillsFixtures(dataDir);
    expect(
      reloaded?.fixtures.map((fixture: HybridaiSkillFixture) => fixture.id),
    ).toEqual(original.fixtures.map((fixture) => fixture.id));
    expect(reloaded?.sourceFiles).toEqual(['development.md']);
  });

  test('returns null when no fixtures are on disk', () => {
    const dataDir = makeTempDir();
    expect(readHybridaiSkillsFixtures(dataDir)).toBeNull();
  });
});
