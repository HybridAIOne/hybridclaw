import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

describe('llm-wiki bundled skill', () => {
  const originalHome = process.env.HOME;
  const originalDisableWatcher = process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
  const tempHomes: string[] = [];

  beforeEach(() => {
    const tempHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-llm-wiki-skill-'),
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
      process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER =
        originalDisableWatcher;
    }
    while (tempHomes.length > 0) {
      const tempHome = tempHomes.pop();
      if (!tempHome) continue;
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test('loads llm-wiki bundled skill metadata', async () => {
    const { loadSkillCatalog } = await import('../src/skills/skills.ts');
    const catalog = loadSkillCatalog();

    expect(catalog.find((skill) => skill.name === 'llm-wiki')).toMatchObject({
      userInvocable: true,
      available: true,
      metadata: {
        hybridclaw: {
          tags: ['wiki', 'knowledge-base', 'research', 'markdown', 'obsidian'],
          relatedSkills: ['obsidian', 'pdf', 'notion'],
        },
      },
    });
  });

  test('syncs llm-wiki templates into workspace skills', async () => {
    const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
    const { loadSkills } = await import('../src/skills/skills.ts');

    const skills = loadSkills('llm-wiki-agent');
    const workspaceDir = agentWorkspaceDir('llm-wiki-agent');
    const llmWiki = skills.find((skill) => skill.name === 'llm-wiki');

    expect(llmWiki?.location).toBe('skills/llm-wiki/SKILL.md');
    expect(
      fs.existsSync(
        path.join(
          workspaceDir,
          'skills',
          'llm-wiki',
          'templates',
          'AGENTS.md',
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          workspaceDir,
          'skills',
          'llm-wiki',
          'templates',
          'wiki',
          'entities',
          '.gitkeep',
        ),
      ),
    ).toBe(true);
    expect(
      fs
        .readFileSync(
          path.join(workspaceDir, 'skills', 'llm-wiki', 'SKILL.md'),
          'utf8',
        )
        .includes('append-only timeline'),
    ).toBe(true);
  });
});
