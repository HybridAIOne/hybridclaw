import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

describe('office bundled skills', () => {
  const originalHome = process.env.HOME;
  const originalDisableWatcher = process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
  const tempHomes: string[] = [];

  beforeEach(() => {
    const tempHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-office-skills-'),
    );
    tempHomes.push(tempHome);
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalDisableWatcher === undefined) {
      delete process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
    } else {
      process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = originalDisableWatcher;
    }
    while (tempHomes.length > 0) {
      const tempHome = tempHomes.pop();
      if (!tempHome) continue;
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test('loads office-related bundled skill metadata', async () => {
    const { loadSkillCatalog } = await import('../src/skills/skills.ts');
    const catalog = loadSkillCatalog();

    expect(catalog.find((skill) => skill.name === 'office')).toMatchObject({
      userInvocable: false,
      disableModelInvocation: true,
    });
    expect(catalog.find((skill) => skill.name === 'docx')).toMatchObject({
      requires: {
        bins: ['node'],
        env: [],
      },
      metadata: {
        hybridclaw: {
          tags: ['office', 'document', 'docx'],
        },
      },
    });
    expect(catalog.find((skill) => skill.name === 'xlsx')).toMatchObject({
      requires: {
        bins: ['node'],
        env: [],
      },
      metadata: {
        hybridclaw: {
          tags: ['office', 'spreadsheet', 'xlsx'],
        },
      },
    });
    expect(catalog.find((skill) => skill.name === 'pptx')).toMatchObject({
      requires: {
        bins: ['node'],
        env: [],
      },
      metadata: {
        hybridclaw: {
          tags: ['office', 'presentation', 'pptx'],
        },
      },
    });
    expect(
      catalog.find((skill) => skill.name === 'office-workflows'),
    ).toMatchObject({
      userInvocable: true,
      metadata: {
        hybridclaw: {
          tags: ['office', 'workflow', 'delegation'],
        },
      },
    });
  });

  test('syncs bundled skills into workspace/skills for script-path compatibility', async () => {
    const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
    const { buildSkillsPrompt, loadSkills } = await import(
      '../src/skills/skills.ts'
    );

    const skills = loadSkills('office-agent');
    const workspaceDir = agentWorkspaceDir('office-agent');

    expect(skills.find((skill) => skill.name === 'pdf')?.location).toBe(
      'skills/pdf/SKILL.md',
    );
    expect(skills.find((skill) => skill.name === 'office')?.location).toBe(
      'skills/office/SKILL.md',
    );
    expect(
      fs
        .readFileSync(
          path.join(workspaceDir, 'skills', 'xlsx', 'SKILL.md'),
          'utf8',
        )
        .includes(
          'Put new helper scripts in workspace `scripts/` or the workspace root',
        ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          workspaceDir,
          'skills',
          'pdf',
          'scripts',
          'extract_pdf_text.mjs',
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(workspaceDir, 'skills', 'office', 'pack.cjs')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(workspaceDir, 'skills', 'office', 'unpack.cjs')),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(workspaceDir, 'skills', 'office', 'validate.cjs'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(workspaceDir, 'skills', 'office', 'soffice.cjs')),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(workspaceDir, 'skills', 'pptx', 'scripts', 'thumbnail.cjs'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          workspaceDir,
          'skills',
          'xlsx',
          'scripts',
          'import_delimited.cjs',
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(workspaceDir, 'skills', 'docx', 'scripts', 'comment.cjs'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          workspaceDir,
          'skills',
          'docx',
          'scripts',
          'accept_changes.cjs',
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(workspaceDir, 'skills', 'office', 'templates', '.gitkeep'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(workspaceDir, 'skills', 'office', 'pack.py')),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(workspaceDir, 'skills', 'office', 'soffice.py')),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(workspaceDir, 'skills', 'xlsx', 'scripts', 'recalc.py'),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(workspaceDir, 'skills', 'pptx', 'scripts', 'thumbnail.py'),
      ),
    ).toBe(false);
    expect(buildSkillsPrompt(skills)).not.toContain('<name>office</name>');
  });

  test('prunes stale mirrored bundled skills from agent workspaces', async () => {
    const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
    const { loadSkills } = await import('../src/skills/skills.ts');

    const workspaceDir = agentWorkspaceDir('office-agent-prune');
    const staleSkillDir = path.join(workspaceDir, 'skills', 'repo-orientation');
    fs.mkdirSync(staleSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(staleSkillDir, 'SKILL.md'),
      'name: repo-orientation\ndescription: stale\n',
      'utf8',
    );

    loadSkills('office-agent-prune');

    expect(fs.existsSync(staleSkillDir)).toBe(false);
    expect(
      fs.existsSync(path.join(workspaceDir, 'skills', 'office', 'SKILL.md')),
    ).toBe(true);
  });

  test('refreshes mirrored bundled skill scripts when helper files change', async () => {
    const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
    const { loadSkills } = await import('../src/skills/skills.ts');

    const agentId = 'office-agent-refresh';
    const workspaceDir = agentWorkspaceDir(agentId);
    const mirroredThumbnailPath = path.join(
      workspaceDir,
      'skills',
      'pptx',
      'scripts',
      'thumbnail.cjs',
    );
    const sourceThumbnailPath = path.resolve(
      process.cwd(),
      'skills',
      'pptx',
      'scripts',
      'thumbnail.cjs',
    );

    loadSkills(agentId);

    fs.writeFileSync(
      mirroredThumbnailPath,
      '#!/usr/bin/env node\nmodule.exports = { stale: true };\n',
      'utf8',
    );

    loadSkills(agentId);

    expect(fs.readFileSync(mirroredThumbnailPath, 'utf8')).toBe(
      fs.readFileSync(sourceThumbnailPath, 'utf8'),
    );
  });
});
