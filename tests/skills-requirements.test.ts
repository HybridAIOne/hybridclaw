import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');

function readJson<T>(relativePath: string): T {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8'),
  ) as T;
}

/** Package name for a bare specifier, keeping the scope and dropping subpaths. */
function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

describe('skill node_modules requirements', () => {
  const originalHome = process.env.HOME;
  let tempHome = '';

  beforeEach(() => {
    tempHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-skill-requirements-'),
    );
    vi.stubEnv('HOME', tempHome);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  async function writeSkill(
    name: string,
    frontmatterLines: string[],
  ): Promise<void> {
    const { DEFAULT_RUNTIME_HOME_DIR } = await import(
      '../src/config/runtime-paths.ts'
    );
    const skillDir = path.join(DEFAULT_RUNTIME_HOME_DIR, 'skills', name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        `name: ${name}`,
        `description: ${name} test skill.`,
        ...frontmatterLines,
        '---',
        '',
        `# ${name}`,
      ].join('\n'),
      'utf8',
    );
  }

  async function findSkill(name: string) {
    const { findSkillCatalogEntry } = await import(
      '../src/skills/skills-install.ts'
    );
    return findSkillCatalogEntry(name);
  }

  test('parses node_modules from a requires block', async () => {
    await writeSkill('deck-maker', [
      'requires:',
      '  bins:',
      '    - node',
      '  node_modules:',
      '    - pptxgenjs',
      '    - csv-parse/sync',
    ]);
    const skill = await findSkill('deck-maker');
    expect(skill?.requires).toEqual({
      bins: ['node'],
      env: [],
      nodeModules: ['pptxgenjs', 'csv-parse/sync'],
    });
  });

  test('parses node_modules from an inline requires object', async () => {
    await writeSkill('inline-deck', [
      'requires: {"node_modules": ["yaml"]}',
    ]);
    const skill = await findSkill('inline-deck');
    expect(skill?.requires).toEqual({
      bins: [],
      env: [],
      nodeModules: ['yaml'],
    });
  });

  test('marks a skill unavailable when a required module does not resolve', async () => {
    await writeSkill('needs-missing-module', [
      'requires:',
      '  node_modules:',
      '    - hybridclaw-definitely-missing-module',
    ]);
    const skill = await findSkill('needs-missing-module');
    expect(skill?.available).toBe(false);
    expect(skill?.missing).toEqual([
      'node_module:hybridclaw-definitely-missing-module',
    ]);
  });

  test('keeps a skill available when the required module resolves', async () => {
    // `yaml` is a gateway dependency, resolvable from the repo root the test
    // process runs in, which mirrors the runtime images' NODE_PATH setup.
    await writeSkill('needs-present-module', [
      'requires:',
      '  node_modules:',
      '    - yaml',
    ]);
    const skill = await findSkill('needs-present-module');
    expect(skill?.missing).toEqual([]);
    expect(skill?.available).toBe(true);
  });

  test('does not offer gateway-only modules to container agents', async () => {
    const { setSandboxModeOverride } = await import('../src/config/config.ts');
    setSandboxModeOverride('container');
    try {
      await writeSkill('gateway-only-module', [
        'requires:',
        '  node_modules:',
        '    - discord.js',
      ]);
      const skill = await findSkill('gateway-only-module');
      expect(skill?.available).toBe(false);
      expect(skill?.missing).toEqual(['node_module:discord.js']);
    } finally {
      setSandboxModeOverride(null);
    }
  });

  test('checks each agent runtime against its own dependencies', async () => {
    const { hasAgentNodeModule } = await import(
      '../src/skills/skill-node-modules.ts'
    );
    expect(hasAgentNodeModule('discord.js', 'container')).toBe(false);
    expect(hasAgentNodeModule('discord.js', 'host')).toBe(true);
    expect(hasAgentNodeModule('pptxgenjs', 'container')).toBe(true);
    expect(hasAgentNodeModule('pptxgenjs/../missing', 'container')).toBe(false);
  });

  test('rejects relative and absolute specifiers', async () => {
    const { hasResolvableNodeModule } = await import(
      '../src/utils/node-modules.ts'
    );
    expect(hasResolvableNodeModule('./local.js')).toBe(false);
    expect(hasResolvableNodeModule('/etc/passwd')).toBe(false);
    expect(hasResolvableNodeModule('')).toBe(false);
    expect(hasResolvableNodeModule('yaml')).toBe(true);
  });
});

describe('bundled skill requirements match the packaged runtime images', () => {
  test('every required node module ships in both images', async () => {
    const { loadSkillCatalog } = await import('../src/skills/skills.ts');
    const bundled = loadSkillCatalog().filter(
      (skill) => skill.source === 'bundled',
    );
    expect(bundled.length).toBeGreaterThan(0);

    // Dependency sets present in both the standalone agent image and the
    // gateway image: the shared tools manifest and the container runtime's
    // own dependencies. The gateway's root package.json is gateway-only and
    // deliberately excluded.
    const shipped = new Set<string>([
      ...Object.keys(
        readJson<{ dependencies: Record<string, string> }>(
          'container/tools/package.json',
        ).dependencies,
      ),
      ...Object.keys(
        readJson<{ dependencies: Record<string, string> }>(
          'container/package.json',
        ).dependencies,
      ),
    ]);

    const violations: string[] = [];
    for (const skill of bundled) {
      for (const specifier of skill.requires.nodeModules) {
        if (!shipped.has(packageNameOf(specifier))) {
          violations.push(`${skill.name}: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('office skills declare the libraries their instructions and scripts use', async () => {
    const { loadSkillCatalog } = await import('../src/skills/skills.ts');
    const byName = new Map(
      loadSkillCatalog()
        .filter((skill) => skill.source === 'bundled')
        .map((skill) => [skill.name, skill.requires.nodeModules]),
    );
    expect(byName.get('pptx')).toContain('pptxgenjs');
    expect(byName.get('docx')).toContain('docx');
    expect(byName.get('xlsx')).toEqual(
      expect.arrayContaining(['xlsx', 'xlsx-populate']),
    );
    expect(byName.get('pdf')).toEqual(
      expect.arrayContaining(['pdf-lib', 'pdfjs-dist']),
    );
  });
});
