import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { writeZipArchive } from '../helpers/zip-archive.ts';
import { useCleanMocks, useTempDir } from '../test-utils.ts';

const originalCwd = process.cwd();

const makeTempDir = useTempDir();

useCleanMocks({
  cleanup: () => {
    process.chdir(originalCwd);
  },
  restoreAllMocks: false,
  resetModules: true,
  unstubAllEnvs: true,
  unmock: ['../../src/infra/ipc.ts', '../../src/infra/ipc.js'],
});

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/infra/ipc.ts');
  vi.doUnmock('../../src/infra/ipc.js');
});

function useRuntimeHome(): { homeDir: string; cwd: string } {
  const homeDir = makeTempDir('hybridclaw-claw-home-');
  const cwd = makeTempDir('hybridclaw-claw-cwd-');
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  process.chdir(cwd);
  return { homeDir, cwd };
}

async function initRuntime(agentIds: string[]): Promise<void> {
  const { initDatabase } = await import('../../src/memory/db.js');
  const { initAgentRegistry } = await import(
    '../../src/agents/agent-registry.js'
  );
  initDatabase({ quiet: true });
  initAgentRegistry({ list: agentIds.map((id) => ({ id, name: id })) });
}

describe('agent uninstall', () => {
  test('removes a non-main agent registration and workspace root', async () => {
    useRuntimeHome();
    const { listMemoryValues, setMemoryValue } = await import(
      '../../src/memory/db.js'
    );
    const { getAgentById } = await import('../../src/agents/agent-registry.js');
    const { agentWorkspaceDir } = await import('../../src/infra/ipc.js');
    const { ensureBootstrapFiles } = await import('../../src/workspace.js');
    const { uninstallAgent } = await import(
      '../../src/agents/agent-uninstall.js'
    );
    await initRuntime(['main', 'writer']);

    const workspacePath = agentWorkspaceDir('writer');
    const agentRootPath = path.dirname(workspacePath);
    ensureBootstrapFiles('writer');
    fs.writeFileSync(
      path.join(workspacePath, 'notes.md'),
      '# Writer\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(agentRootPath, 'metadata.json'),
      '{"name":"Writer Agent"}\n',
      'utf-8',
    );
    setMemoryValue('session-a', 'gateway.bootstrap_autostart.v1.writer', {
      status: 'completed',
    });
    setMemoryValue(
      'session-b',
      'gateway.bootstrap_autostart.v1.writer.BOOTSTRAP.md.abc123',
      { status: 'completed' },
    );
    setMemoryValue(
      'session-c',
      'gateway.bootstrap_autostart.v1.writer2.BOOTSTRAP.md.keep',
      { status: 'completed' },
    );

    expect(getAgentById('writer')).toMatchObject({ id: 'writer' });
    expect(fs.existsSync(agentRootPath)).toBe(true);

    const result = uninstallAgent('writer');

    expect(result).toMatchObject({
      agentId: 'writer',
      agentRootPath,
      workspacePath,
      removedAgentRoot: true,
      removedRegistration: true,
      removedSkillsExtraDir: false,
      removedBootstrapAutostartMarkers: 2,
    });
    expect(getAgentById('writer')).toBeNull();
    expect(fs.existsSync(agentRootPath)).toBe(false);
    expect(listMemoryValues('session-a')).toEqual([]);
    expect(listMemoryValues('session-b')).toEqual([]);
    expect(listMemoryValues('session-c')).toEqual([
      expect.objectContaining({
        key: 'gateway.bootstrap_autostart.v1.writer2.BOOTSTRAP.md.keep',
      }),
    ]);
  });

  test('removes the skills.extraDirs entry its .claw install added', async () => {
    const { homeDir, cwd } = useRuntimeHome();
    const { getRuntimeConfig, updateRuntimeConfig } = await import(
      '../../src/config/runtime-config.js'
    );
    const { agentWorkspaceDir } = await import('../../src/infra/ipc.js');
    const { unpackAgent } = await import('../../src/agents/claw-archive.js');
    const { uninstallAgent } = await import(
      '../../src/agents/agent-uninstall.js'
    );
    await initRuntime(['main']);

    const keptDirs = [
      path.join(agentWorkspaceDir('other'), 'skills'),
      path.join(homeDir, 'shared-skills'),
    ];
    updateRuntimeConfig((draft) => {
      draft.skills.extraDirs = [...keptDirs];
    });
    const archivePath = path.join(cwd, 'writer.claw');
    await writeZipArchive(archivePath, [
      {
        name: 'manifest.json',
        content: JSON.stringify({
          formatVersion: 1,
          name: 'Writer',
          id: 'writer',
          skills: { bundled: ['notes'] },
        }),
      },
      { name: 'workspace/SOUL.md', content: '# Soul\n' },
      {
        name: 'skills/notes/SKILL.md',
        content:
          '---\nname: notes\ndescription: Test skill\n---\n\nTake notes.\n',
      },
    ]);
    const { workspacePath } = await unpackAgent(archivePath, {
      yes: true,
      homeDir,
      cwd,
    });
    const skillsDir = path.join(workspacePath, 'skills');
    expect(getRuntimeConfig().skills.extraDirs).toContain(skillsDir);

    const result = uninstallAgent('writer');

    expect(result).toMatchObject({
      removedAgentRoot: true,
      removedRegistration: true,
      removedSkillsExtraDir: true,
    });
    expect([...getRuntimeConfig().skills.extraDirs].sort()).toEqual(
      [...keptDirs].sort(),
    );
  });

  test.each([
    { form: 'absolute', toEntry: (dir: string) => dir },
    { form: 'trailing slash', toEntry: (dir: string) => `${dir}/` },
    {
      form: 'home-relative',
      toEntry: (dir: string, homeDir: string) =>
        `~/${path.relative(homeDir, dir)}`,
    },
  ])(
    'clears a $form entry an earlier uninstall left behind',
    async ({ toEntry }) => {
      const { homeDir } = useRuntimeHome();
      const { getRuntimeConfig, updateRuntimeConfig } = await import(
        '../../src/config/runtime-config.js'
      );
      const { agentWorkspaceDir } = await import('../../src/infra/ipc.js');
      const { uninstallAgent } = await import(
        '../../src/agents/agent-uninstall.js'
      );
      await initRuntime(['main']);

      const keptDir = path.join(homeDir, 'shared-skills');
      const skillsDir = path.join(agentWorkspaceDir('writer'), 'skills');
      updateRuntimeConfig((draft) => {
        draft.skills.extraDirs = [toEntry(skillsDir, homeDir), keptDir];
      });

      expect(uninstallAgent('writer')).toMatchObject({
        removedAgentRoot: false,
        removedRegistration: false,
        removedSkillsExtraDir: true,
      });
      expect(getRuntimeConfig().skills.extraDirs).toEqual([keptDir]);
    },
  );

  test('rejects an agent with nothing left to remove', async () => {
    useRuntimeHome();
    const { uninstallAgent } = await import(
      '../../src/agents/agent-uninstall.js'
    );
    await initRuntime(['main']);

    expect(() => uninstallAgent('writer')).toThrow(
      'Agent "writer" is not installed.',
    );
  });

  test('rejects the main agent', async () => {
    useRuntimeHome();
    const { uninstallAgent } = await import(
      '../../src/agents/agent-uninstall.js'
    );
    await initRuntime(['main']);

    expect(() => uninstallAgent('main')).toThrow(
      'The main agent cannot be uninstalled.',
    );
  });

  test('refuses to remove agent roots outside the agents data directory', async () => {
    useRuntimeHome();
    const outsideRoot = makeTempDir('hybridclaw-claw-outside-');
    fs.mkdirSync(path.join(outsideRoot, 'workspace'), { recursive: true });
    fs.writeFileSync(path.join(outsideRoot, 'notes.md'), 'do not delete\n');

    vi.doMock('../../src/infra/ipc.js', async () => {
      const actual = await vi.importActual<
        typeof import('../../src/infra/ipc.js')
      >('../../src/infra/ipc.js');
      return {
        ...actual,
        agentWorkspaceDir: vi.fn(() => path.join(outsideRoot, 'workspace')),
      };
    });

    const { uninstallAgent } = await import(
      '../../src/agents/agent-uninstall.js'
    );

    expect(() =>
      uninstallAgent('writer', {
        existingAgent: { id: 'writer', name: 'Writer Agent' },
      }),
    ).toThrow(`Refusing to remove agent files outside`);
    expect(fs.existsSync(outsideRoot)).toBe(true);
    expect(fs.existsSync(path.join(outsideRoot, 'notes.md'))).toBe(true);
  });
});
