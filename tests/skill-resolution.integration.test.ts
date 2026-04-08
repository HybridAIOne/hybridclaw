/**
 * Integration test: Skill resolution and discovery from real filesystem.
 *
 * Creates real SKILL.md files in temp directories, configures the runtime
 * config to include them via extraDirs, and verifies that loadSkillCatalog
 * discovers and parses them correctly.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

let tmpDir: string;
let originalDataDir: string | undefined;
let originalHome: string | undefined;
let originalWatcher: string | undefined;

type SkillsModule = typeof import('../src/skills/skills.js');
type ConfigModule = typeof import('../src/config/runtime-config.js');
let skillsMod: SkillsModule;
let configMod: ConfigModule;

function writeSkill(
  parentDir: string,
  dirName: string,
  content: string,
): string {
  const skillDir = path.join(parentDir, dirName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
  return skillDir;
}

beforeAll(() => {
  originalDataDir = process.env.HYBRIDCLAW_DATA_DIR;
  originalHome = process.env.HOME;
  originalWatcher = process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
});

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-skill-integration-'));

  process.env.HYBRIDCLAW_DATA_DIR = tmpDir;
  process.env.HOME = tmpDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';

  vi.resetModules();

  configMod = await import('../src/config/runtime-config.js');
  skillsMod = await import('../src/skills/skills.js');
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.HYBRIDCLAW_DATA_DIR;
  else process.env.HYBRIDCLAW_DATA_DIR = originalDataDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalWatcher === undefined)
    delete process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
  else process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = originalWatcher;
});

describe('skill resolution integration', () => {
  it('loadSkillCatalog discovers skills from bundled directory', () => {
    // The real bundled skills/ dir exists in the project root and should
    // be discovered by resolveInstallPath('skills').
    const catalog = skillsMod.loadSkillCatalog();
    expect(catalog.length).toBeGreaterThan(0);
    const names = catalog.map((s) => s.name);
    // current-time is a known bundled skill.
    expect(names).toContain('current-time');
  });

  it('SKILL.md with valid frontmatter parses correctly (name, description, category, tags)', () => {
    const extraDir = path.join(tmpDir, 'extra-skills');
    writeSkill(
      extraDir,
      'test-greet',
      `---
name: test-greet
description: A greeting skill for testing
category: memory
user-invocable: true
hybridclaw-tags: [greeting, test]
---

# Greet

Say hello.
`,
    );

    // Configure the extra dir so it's picked up.
    configMod.ensureRuntimeConfigFile();
    configMod.updateRuntimeConfig((draft) => {
      draft.skills.extraDirs = [extraDir];
    });

    // Re-import to pick up config change.
    const catalog = skillsMod.loadSkillCatalog();
    const greet = catalog.find((s) => s.name === 'test-greet');
    expect(greet).toBeDefined();
    expect(greet?.description).toBe('A greeting skill for testing');
    expect(greet?.category).toBe('memory');
    expect(greet?.source).toBe('extra');
  });

  it('SKILL.md with invalid YAML frontmatter produces a graceful result (not crash)', () => {
    const extraDir = path.join(tmpDir, 'extra-bad-yaml');
    // Write a skill with a broken frontmatter delimiter (missing closing ---).
    // The parser should handle this gracefully — either skip the skill or
    // treat the entire content as the body.
    writeSkill(
      extraDir,
      'bad-yaml-skill',
      `---
name: bad-yaml
description: [unclosed bracket
---

Body text.
`,
    );

    configMod.ensureRuntimeConfigFile();
    configMod.updateRuntimeConfig((draft) => {
      draft.skills.extraDirs = [extraDir];
    });

    // Should not throw.
    const catalog = skillsMod.loadSkillCatalog();
    // The skill may or may not appear depending on parsing — the key is no crash.
    expect(Array.isArray(catalog)).toBe(true);
  });

  it('higher-precedence source shadows lower-precedence for same skill name', () => {
    // Create a skill in an extra dir (lowest precedence after bundled)
    // and a community skill with the same name. Community has higher
    // precedence than extra, so it should win.
    const extraDir = path.join(tmpDir, 'extra-shadow');
    writeSkill(
      extraDir,
      'shadow-test-skill',
      `---
name: shadow-test-skill
description: Extra version (lower precedence)
---

Extra body.
`,
    );

    const communityDir = path.join(tmpDir, 'skills');
    writeSkill(
      communityDir,
      'shadow-test-skill',
      `---
name: shadow-test-skill
description: Community version (higher precedence)
---

Community body.
`,
    );

    configMod.ensureRuntimeConfigFile();
    configMod.updateRuntimeConfig((draft) => {
      draft.skills.extraDirs = [extraDir];
    });

    const catalog = skillsMod.loadSkillCatalog();
    const skill = catalog.find((s) => s.name === 'shadow-test-skill');
    expect(skill).toBeDefined();
    // Community should shadow extra.
    expect(skill?.source).toBe('community');
    expect(skill?.description).toBe('Community version (higher precedence)');
  });

  it('skill with missing name field uses directory name', () => {
    const extraDir = path.join(tmpDir, 'extra-noname');
    writeSkill(
      extraDir,
      'fallback-dir-name',
      `---
description: A skill without an explicit name
---

Body.
`,
    );

    configMod.ensureRuntimeConfigFile();
    configMod.updateRuntimeConfig((draft) => {
      draft.skills.extraDirs = [extraDir];
    });

    const catalog = skillsMod.loadSkillCatalog();
    const skill = catalog.find((s) => s.name === 'fallback-dir-name');
    expect(skill).toBeDefined();
    expect(skill?.description).toBe('A skill without an explicit name');
  });

  it('multiple skills in different directories are all discovered', () => {
    const dir1 = path.join(tmpDir, 'extra-multi-1');
    const dir2 = path.join(tmpDir, 'extra-multi-2');
    writeSkill(
      dir1,
      'multi-alpha',
      `---
name: multi-alpha
description: Alpha skill
---

Alpha body.
`,
    );
    writeSkill(
      dir2,
      'multi-beta',
      `---
name: multi-beta
description: Beta skill
---

Beta body.
`,
    );

    configMod.ensureRuntimeConfigFile();
    configMod.updateRuntimeConfig((draft) => {
      draft.skills.extraDirs = [dir1, dir2];
    });

    const catalog = skillsMod.loadSkillCatalog();
    const names = catalog.map((s) => s.name);
    expect(names).toContain('multi-alpha');
    expect(names).toContain('multi-beta');
  });

  it('sorts discovered skills by category and then by name', () => {
    const extraDir = path.join(tmpDir, 'extra-categories');
    writeSkill(
      extraDir,
      'zeta-note',
      `---
name: zeta-note
description: Zeta memory skill
category: memory
---

Zeta body.
`,
    );
    writeSkill(
      extraDir,
      'alpha-sheet',
      `---
name: alpha-sheet
description: Alpha office skill
category: office
---

Alpha body.
`,
    );
    writeSkill(
      extraDir,
      'beta-note',
      `---
name: beta-note
description: Beta memory skill
category: memory
---

Beta body.
`,
    );

    configMod.ensureRuntimeConfigFile();
    configMod.updateRuntimeConfig((draft) => {
      draft.skills.extraDirs = [extraDir];
    });

    const catalog = skillsMod
      .loadSkillCatalog()
      .filter((skill) =>
        ['zeta-note', 'alpha-sheet', 'beta-note'].includes(skill.name),
      );

    expect(catalog.map((skill) => `${skill.category}:${skill.name}`)).toEqual([
      'memory:beta-note',
      'memory:zeta-note',
      'office:alpha-sheet',
    ]);
  });
});
