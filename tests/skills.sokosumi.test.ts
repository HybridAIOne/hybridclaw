import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

describe('sokosumi bundled skill', () => {
  const originalHome = process.env.HOME;
  const originalDisableWatcher = process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
  const tempHomes: string[] = [];

  beforeEach(() => {
    const tempHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-sokosumi-skill-'),
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

  test('loads sokosumi bundled skill metadata', async () => {
    const { loadSkillCatalog } = await import('../src/skills/skills.ts');
    const catalog = loadSkillCatalog();

    expect(catalog.find((skill) => skill.name === 'sokosumi')).toMatchObject({
      category: 'agents',
      userInvocable: true,
      available: true,
      metadata: {
        hybridclaw: {
          tags: ['sokosumi', 'marketplace', 'agents', 'automation', 'api'],
          relatedSkills: ['project-manager', 'feature-planning'],
          install: [],
        },
      },
    });
  });

  test('syncs sokosumi bundled assets into workspace skills', async () => {
    const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
    const { loadSkills } = await import('../src/skills/skills.ts');

    const skills = loadSkills('sokosumi-agent');
    const workspaceDir = agentWorkspaceDir('sokosumi-agent');
    const sokosumi = skills.find((skill) => skill.name === 'sokosumi');

    expect(sokosumi?.location).toBe('skills/sokosumi/SKILL.md');
    expect(
      fs.existsSync(
        path.join(workspaceDir, 'skills', 'sokosumi', 'agents', 'openai.yaml'),
      ),
    ).toBe(true);
    expect(
      fs
        .readFileSync(
          path.join(workspaceDir, 'skills', 'sokosumi', 'SKILL.md'),
          'utf8',
        )
        .includes('10 to 20 minutes'),
    ).toBe(true);
  });
});
