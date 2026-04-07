import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

describe('llm-wiki bundled skill', () => {
  let tempHome = '';

  beforeEach(() => {
    tempHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-llm-wiki-skill-'),
    );
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true });
      tempHome = '';
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
          tags: ['wiki', 'knowledge-base', 'research', 'markdown'],
          relatedSkills: ['pdf', 'notion'],
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
        path.join(workspaceDir, 'skills', 'llm-wiki', 'templates', 'AGENTS.md'),
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
    const skillContent = fs.readFileSync(
      path.join(workspaceDir, 'skills', 'llm-wiki', 'SKILL.md'),
      'utf8',
    );
    expect(skillContent).toContain('Orient Every Session');
    expect(skillContent).toContain('skills/llm-wiki/templates/AGENTS.md');
    expect(skillContent).not.toContain('### Recommended Frontmatter');

    const agentsContent = fs.readFileSync(
      path.join(workspaceDir, 'skills', 'llm-wiki', 'templates', 'AGENTS.md'),
      'utf8',
    );
    expect(agentsContent).toContain('Tag Taxonomy');
    expect(agentsContent).toContain('Lint Checks');
    expect(agentsContent).not.toContain('## Obsidian');
  });
});
