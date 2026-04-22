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

  it('bundled pdf skill description advertises creation and invoice workflows', () => {
    const catalog = skillsMod.loadSkillCatalog();
    const pdfSkill = catalog.find((skill) => skill.name === 'pdf');

    expect(pdfSkill).toBeDefined();
    expect(pdfSkill?.description).toContain('Create new PDFs');
    expect(pdfSkill?.description).toContain('invoice/document parsing');
  });

  it('advertises gog for Google Calendar event access', () => {
    const catalog = skillsMod.loadSkillCatalog();
    const gogSkill = catalog.find((skill) => skill.name === 'gog');
    const gwsSkill = catalog.find((skill) => skill.name === 'gws');
    const googleWorkspaceSkill = fs.readFileSync(
      path.resolve('skills/google-workspace/SKILL.md'),
      'utf-8',
    );

    expect(gogSkill?.description).toContain('Google Calendar');
    expect(gogSkill?.description).toContain('events');
    expect(gogSkill?.description).toContain('meetings');
    const gogSkillBody = fs.readFileSync(
      path.resolve('skills/gog/SKILL.md'),
      'utf-8',
    );
    expect(gogSkillBody).toContain('searches all available calendars');
    expect(gogSkillBody).toContain('Do not pipe `gog ... --json`');
    expect(googleWorkspaceSkill).toContain(
      'API-backed Google Workspace access',
    );
    expect(googleWorkspaceSkill).toContain(
      'Use `gws` or `gog` without asking clarifying questions',
    );
    expect(googleWorkspaceSkill).not.toContain(
      'Navigate to the relevant Google service via browser automation',
    );
    expect(gwsSkill?.metadata.hybridclaw.install).toEqual([
      expect.objectContaining({
        id: 'gws',
        kind: 'npm',
        label: 'Install Google Workspace CLI (npm)',
        bins: ['gws'],
      }),
    ]);
    const gwsSkillBody = fs.readFileSync(
      path.resolve('skills/gws/SKILL.md'),
      'utf-8',
    );
    expect(gwsSkillBody).toContain('credential_source` is `"token_env_var"');
    expect(gwsSkillBody).toContain('token_env_var` is `true`');
    expect(gwsSkillBody).toContain('Do not add `--json`');
    expect(gwsSkillBody).toContain('gws auth status --json` is invalid');
    expect(gwsSkillBody).toContain('do not ask the user to log in again');
  });

  it('uses dependency names as bundled skill install ids', () => {
    const catalog = skillsMod.loadSkillCatalog();
    const installsBySkill = new Map(
      catalog.map((skill) => [
        skill.name,
        skill.metadata.hybridclaw.install.map((install) => ({
          id: install.id,
          kind: install.kind,
          bins: install.bins,
        })),
      ]),
    );

    expect(installsBySkill.get('1password')).toEqual([
      { id: 'op', kind: 'brew', bins: ['op'] },
    ]);
    expect(installsBySkill.get('gh-issues')).toEqual([
      { id: 'gh', kind: 'brew', bins: ['gh'] },
    ]);
    expect(installsBySkill.get('gog')).toEqual([
      { id: 'gog', kind: 'brew', bins: ['gog'] },
    ]);
    expect(installsBySkill.get('gws')).toEqual([
      { id: 'gws', kind: 'npm', bins: ['gws'] },
    ]);
    expect(installsBySkill.get('manim-video')).toEqual([
      { id: 'manim', kind: 'uv', bins: ['manim'] },
      { id: 'ffmpeg', kind: 'brew', bins: ['ffmpeg'] },
    ]);
    expect(installsBySkill.get('wordpress')).toEqual([
      { id: 'wp', kind: 'brew', bins: ['wp'] },
    ]);
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

  it('SKILL.md parses metadata.hybridclaw category and short description', () => {
    const extraDir = path.join(tmpDir, 'extra-metadata-skills');
    writeSkill(
      extraDir,
      'test-metadata-skill',
      `---
name: test-metadata-skill
description: Detailed description for the metadata test skill
metadata:
  hybridclaw:
    category: Knowledge Base
    short_description: Concise metadata summary.
    tags:
      - metadata
      - parser
---

# Metadata Skill

Validate metadata parsing.
`,
    );

    configMod.ensureRuntimeConfigFile();
    configMod.updateRuntimeConfig((draft) => {
      draft.skills.extraDirs = [extraDir];
    });

    const catalog = skillsMod.loadSkillCatalog();
    const skill = catalog.find((s) => s.name === 'test-metadata-skill');
    expect(skill).toBeDefined();
    expect(skill?.description).toBe(
      'Detailed description for the metadata test skill',
    );
    expect(skill?.category).toBe('knowledge-base');
    expect(skill?.metadata.hybridclaw.shortDescription).toBe(
      'Concise metadata summary.',
    );
    expect(skill?.metadata.hybridclaw.tags).toEqual(['metadata', 'parser']);
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

  it('loadSkills applies per-agent skill allowlists and preserves explicit empty lists', () => {
    const extraDir = path.join(tmpDir, 'agent-filter-skills');
    writeSkill(
      extraDir,
      'draft-outline',
      `---
name: draft-outline
description: Outline drafting skill
---

Outline body.
`,
    );
    writeSkill(
      extraDir,
      'copy-edit',
      `---
name: copy-edit
description: Copy editing skill
---

Edit body.
`,
    );

    configMod.ensureRuntimeConfigFile();
    configMod.updateRuntimeConfig((draft) => {
      draft.skills.extraDirs = [extraDir];
      draft.skills.disabled = [];
      draft.agents.list = [
        { id: 'main', name: 'Main Agent' },
        {
          id: 'writer',
          name: 'Writer Agent',
          skills: ['copy-edit', 'missing-skill'],
        },
        {
          id: 'silent',
          name: 'Silent Agent',
          skills: [],
        },
      ];
    });

    const mainSkills = skillsMod.loadSkills('main');
    expect(mainSkills.some((skill) => skill.name === 'draft-outline')).toBe(
      true,
    );
    expect(mainSkills.some((skill) => skill.name === 'copy-edit')).toBe(true);

    expect(skillsMod.loadSkills('writer').map((skill) => skill.name)).toEqual([
      'copy-edit',
    ]);
    expect(skillsMod.loadSkills('silent')).toEqual([]);
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
