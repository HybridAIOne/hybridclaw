import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { loadIsolatedSkillsRuntime } from './helpers/skills-workspace-runtime.ts';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();
useCleanMocks({
  restoreAllMocks: true,
  resetModules: true,
  unstubAllEnvs: true,
  unmock: ['../src/infra/install-root.js'],
});

function setupTempHome(): string {
  const homeDir = makeTempDir('hybridclaw-promote-skills-');
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  vi.resetModules();
  return homeDir;
}

function writeSkillMd(dir: string, name: string, content?: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    content ??
      `---\nname: ${name}\ndescription: Test skill\n---\n\nA test skill.\n`,
    'utf-8',
  );
}

test('promoteWorkspaceSkills copies new workspace skills to managed dir', async () => {
  const homeDir = setupTempHome();

  const workspaceDir = path.join(homeDir, 'workspace');
  const wsSkillDir = path.join(workspaceDir, 'skills', 'my-new-skill');
  writeSkillMd(wsSkillDir, 'my-new-skill');
  fs.writeFileSync(
    path.join(wsSkillDir, 'run.mjs'),
    'console.log("hello");\n',
    'utf-8',
  );

  const { promoteWorkspaceSkills } = await import('../src/skills/skills.ts');
  promoteWorkspaceSkills(workspaceDir);

  const managedDir = path.join(homeDir, '.hybridclaw', 'skills');
  const promotedDir = path.join(managedDir, 'my-new-skill');
  expect(fs.existsSync(path.join(promotedDir, 'SKILL.md'))).toBe(true);
  expect(fs.existsSync(path.join(promotedDir, 'run.mjs'))).toBe(true);
});

test('promoteWorkspaceSkills skips skills already in managed dir', async () => {
  const homeDir = setupTempHome();
  const managedDir = path.join(homeDir, '.hybridclaw', 'skills');

  // Pre-populate managed dir with an existing skill.
  const existingDir = path.join(managedDir, 'existing-skill');
  writeSkillMd(
    existingDir,
    'existing-skill',
    '---\nname: existing-skill\n---\nOld.\n',
  );

  const workspaceDir = path.join(homeDir, 'workspace');
  const wsSkillDir = path.join(workspaceDir, 'skills', 'existing-skill');
  writeSkillMd(
    wsSkillDir,
    'existing-skill',
    '---\nname: existing-skill\n---\nNew.\n',
  );

  const { promoteWorkspaceSkills } = await import('../src/skills/skills.ts');
  promoteWorkspaceSkills(workspaceDir);

  // The original content should be preserved, not overwritten.
  const content = fs.readFileSync(path.join(existingDir, 'SKILL.md'), 'utf-8');
  expect(content).toContain('Old.');
});

test('promoteWorkspaceSkills is a no-op when workspace has no skills dir', async () => {
  const homeDir = setupTempHome();
  const workspaceDir = path.join(homeDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const { promoteWorkspaceSkills } = await import('../src/skills/skills.ts');

  // Should not throw.
  promoteWorkspaceSkills(workspaceDir);

  const managedDir = path.join(homeDir, '.hybridclaw', 'skills');
  expect(fs.existsSync(managedDir)).toBe(false);
});

test('promoteWorkspaceSkills skips directories without SKILL.md', async () => {
  const homeDir = setupTempHome();
  const workspaceDir = path.join(homeDir, 'workspace');

  // Create a directory in workspace/skills/ that has no SKILL.md.
  const noSkillDir = path.join(workspaceDir, 'skills', 'not-a-skill');
  fs.mkdirSync(noSkillDir, { recursive: true });
  fs.writeFileSync(path.join(noSkillDir, 'random.txt'), 'hi', 'utf-8');

  const { promoteWorkspaceSkills } = await import('../src/skills/skills.ts');
  promoteWorkspaceSkills(workspaceDir);

  const managedDir = path.join(homeDir, '.hybridclaw', 'skills');
  expect(fs.existsSync(managedDir)).toBe(false);
});

describe('after loadSkills synced the catalog into the workspace', () => {
  async function syncedWorkspace() {
    const runtime = await loadIsolatedSkillsRuntime(
      makeTempDir('hybridclaw-promote-skills-'),
    );
    writeSkillMd(path.join(runtime.bundledDir, 'alpha'), 'alpha');
    writeSkillMd(path.join(runtime.bundledDir, 'beta'), 'beta');
    runtime.skills.loadSkills('main');
    return runtime;
  }

  test('skips the catalog scan when the workspace holds only synced copies', async () => {
    const { skills, workspaceDir, managedDir } = await syncedWorkspace();
    expect(
      fs.existsSync(path.join(workspaceDir, 'skills', 'alpha', 'SKILL.md')),
    ).toBe(true);

    const readSpy = vi.spyOn(fs, 'readFileSync');
    skills.promoteWorkspaceSkills(workspaceDir);

    expect(readSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(managedDir)).toBe(false);
  });

  test.each([
    { name: 'a new skill dir', dir: 'agent-made', skillName: 'agent-made' },
    {
      name: 'a synced copy renamed in place',
      dir: 'alpha',
      skillName: 'alpha-v2',
    },
  ])('promotes $name the agent wrote', async ({ dir, skillName }) => {
    const { skills, workspaceDir, managedDir } = await syncedWorkspace();
    writeSkillMd(path.join(workspaceDir, 'skills', dir), skillName);

    skills.promoteWorkspaceSkills(workspaceDir);

    expect(
      fs.readFileSync(path.join(managedDir, dir, 'SKILL.md'), 'utf-8'),
    ).toContain(`name: ${skillName}`);
  });

  test('does not re-promote a synced copy whose source left the catalog', async () => {
    const { skills, bundledDir, workspaceDir, managedDir } =
      await syncedWorkspace();
    fs.rmSync(path.join(bundledDir, 'beta'), { recursive: true });
    writeSkillMd(path.join(workspaceDir, 'skills', 'agent-made'), 'agent-made');

    skills.promoteWorkspaceSkills(workspaceDir);

    expect(fs.existsSync(path.join(managedDir, 'agent-made'))).toBe(true);
    expect(fs.existsSync(path.join(managedDir, 'beta'))).toBe(false);
  });
});
