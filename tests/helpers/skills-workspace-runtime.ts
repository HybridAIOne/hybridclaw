import path from 'node:path';
import { vi } from 'vitest';

/**
 * Loads the skills module against `root` only: HOME, the bundled skills dir
 * and the project cwd all point inside it, so `loadSkills('main')` syncs just
 * the skills a test writes. Pair with
 * `useCleanMocks({ restoreAllMocks: true, resetModules: true, unstubAllEnvs: true })`.
 */
export async function loadIsolatedSkillsRuntime(root: string) {
  const bundledDir = path.join(root, 'bundled-skills');
  vi.stubEnv('HOME', root);
  vi.stubEnv('CODEX_HOME', '');
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  vi.resetModules();
  vi.doMock('../../src/infra/install-root.js', async (importOriginal) => {
    const actual =
      await importOriginal<typeof import('../../src/infra/install-root.js')>();
    return {
      ...actual,
      resolveInstallPath: (...segments: string[]) =>
        segments.join('/') === 'skills'
          ? bundledDir
          : actual.resolveInstallPath(...segments),
    };
  });
  const skills = await import('../../src/skills/skills.ts');
  const { agentWorkspaceDir } = await import('../../src/infra/ipc.ts');
  vi.spyOn(process, 'cwd').mockReturnValue(path.join(root, 'project'));
  return {
    skills,
    bundledDir,
    managedDir: path.join(root, '.hybridclaw', 'skills'),
    workspaceDir: agentWorkspaceDir('main'),
  };
}
