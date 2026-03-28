import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as yazl from 'yazl';

const originalCwd = process.cwd();
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeSkillDir(dir: string, skillName: string): void {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: Test skill\n---\n\nUse the test skill.\n`,
    'utf-8',
  );
  fs.writeFileSync(
    path.join(dir, 'scripts', 'helper.js'),
    'export const helper = true;\n',
    'utf-8',
  );
}

function writePluginDir(
  dir: string,
  pluginId: string,
  options?: { withSearchModeSchema?: boolean },
): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hybridclaw.plugin.yaml'),
    [
      `id: ${pluginId}`,
      'name: Demo Plugin',
      'version: 1.0.0',
      'kind: tool',
      ...(options?.withSearchModeSchema
        ? [
            'configSchema:',
            '  type: object',
            '  additionalProperties: false',
            '  properties:',
            '    searchMode:',
            '      type: string',
          ]
        : []),
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    `export default { id: '${pluginId}', register() {} };\n`,
    'utf-8',
  );
}

function installBundledPluginForTest(
  sourceDir: string,
  homeDir: string,
): {
  pluginId: string;
  pluginDir: string;
  source: string;
  alreadyInstalled: boolean;
  dependenciesInstalled: boolean;
  requiresEnv: string[];
  requiredConfigKeys: string[];
} {
  const manifestPath = path.join(sourceDir, 'hybridclaw.plugin.yaml');
  const manifestText = fs.readFileSync(manifestPath, 'utf-8');
  const pluginIdMatch = manifestText.match(/^id:\s*([^\n]+)$/m);
  const pluginId = pluginIdMatch?.[1]?.trim();
  if (!pluginId) {
    throw new Error(`Test plugin manifest at ${manifestPath} is missing id.`);
  }

  const pluginDir = path.join(homeDir, '.hybridclaw', 'plugins', pluginId);
  fs.mkdirSync(path.dirname(pluginDir), { recursive: true });
  fs.rmSync(pluginDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, pluginDir, { recursive: true });

  return {
    pluginId,
    pluginDir,
    source: sourceDir,
    alreadyInstalled: false,
    dependenciesInstalled: false,
    requiresEnv: [],
    requiredConfigKeys: [],
  };
}

async function writeZipArchive(
  archivePath: string,
  entries: Array<{ name: string; content: string | Buffer; mode?: number }>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const zipFile = new yazl.ZipFile();
    const output = fs.createWriteStream(archivePath);
    output.on('close', resolve);
    output.on('error', reject);
    zipFile.outputStream.on('error', reject).pipe(output);
    for (const entry of entries) {
      zipFile.addBuffer(
        Buffer.isBuffer(entry.content)
          ? entry.content
          : Buffer.from(entry.content, 'utf-8'),
        entry.name,
        entry.mode ? { mode: entry.mode } : undefined,
      );
    }
    zipFile.end();
  });
}

function setZipGeneralPurposeBitFlag(
  archivePath: string,
  flagMask: number,
): void {
  const buffer = fs.readFileSync(archivePath);
  const localHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const centralHeader = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

  let offset = 0;
  while (true) {
    const nextOffset = buffer.indexOf(localHeader, offset);
    if (nextOffset === -1) break;
    offset = nextOffset;
    const current = buffer.readUInt16LE(offset + 6);
    buffer.writeUInt16LE(current | flagMask, offset + 6);
    offset += localHeader.length;
  }

  offset = 0;
  while (true) {
    const nextOffset = buffer.indexOf(centralHeader, offset);
    if (nextOffset === -1) break;
    offset = nextOffset;
    const current = buffer.readUInt16LE(offset + 8);
    buffer.writeUInt16LE(current | flagMask, offset + 8);
    offset += centralHeader.length;
  }

  fs.writeFileSync(archivePath, buffer);
}

afterEach(async () => {
  process.chdir(originalCwd);
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.doUnmock('../../src/agents/claw-security.ts');
  vi.doUnmock('../../src/agents/claw-security.js');
  vi.doUnmock('../../src/plugins/plugin-manager.ts');
  vi.doUnmock('../../src/plugins/plugin-manager.js');
  vi.doUnmock('../../src/plugins/plugin-install.ts');
  vi.doUnmock('../../src/plugins/plugin-install.js');
  vi.doUnmock('../../src/infra/ipc.ts');
  vi.doUnmock('../../src/infra/ipc.js');
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/agents/claw-security.ts');
  vi.doUnmock('../../src/agents/claw-security.js');
  vi.doUnmock('../../src/plugins/plugin-manager.ts');
  vi.doUnmock('../../src/plugins/plugin-manager.js');
  vi.doUnmock('../../src/plugins/plugin-install.ts');
  vi.doUnmock('../../src/plugins/plugin-install.js');
  vi.doUnmock('../../src/infra/ipc.ts');
  vi.doUnmock('../../src/infra/ipc.js');
});

describe('.claw archive support', () => {
  test('packs, inspects, and unpacks an agent round-trip', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

    vi.doMock('../../src/plugins/plugin-install.ts', () => ({
      installPlugin: vi.fn(
        async (source: string, options?: { homeDir?: string }) =>
          installBundledPluginForTest(source, options?.homeDir ?? homeDir),
      ),
    }));
    vi.doMock('../../src/plugins/plugin-install.js', () => ({
      installPlugin: vi.fn(
        async (source: string, options?: { homeDir?: string }) =>
          installBundledPluginForTest(source, options?.homeDir ?? homeDir),
      ),
    }));

    const { getAgentById, initDatabase } = await import(
      '../../src/memory/db.js'
    );
    const { initAgentRegistry } = await import(
      '../../src/agents/agent-registry.js'
    );
    const { updateRuntimeConfig, getRuntimeConfig } = await import(
      '../../src/config/runtime-config.js'
    );
    const { ensureBootstrapFiles } = await import('../../src/workspace.js');
    const { agentWorkspaceDir } = await import('../../src/infra/ipc.js');
    const { loadSkillCatalog } = await import('../../src/skills/skills.js');
    const { inspectClawArchive, packAgent, unpackAgent } = await import(
      '../../src/agents/claw-archive.js'
    );

    initDatabase({ quiet: true });
    initAgentRegistry({
      list: [
        {
          id: 'main',
          name: 'Main Agent',
          displayName: 'Captain Claw',
          imageAsset: 'avatars/main.png',
          model: 'gpt-5-mini',
          enableRag: false,
        },
      ],
    });

    ensureBootstrapFiles('main');
    const sourceWorkspace = agentWorkspaceDir('main');
    fs.mkdirSync(path.join(sourceWorkspace, 'notes'), { recursive: true });
    fs.mkdirSync(path.join(sourceWorkspace, 'avatars'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceWorkspace, 'notes', 'bio.md'),
      'portable memory\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(sourceWorkspace, 'avatars', 'main.png'),
      Buffer.from('89504e470d0a1a0a', 'hex'),
    );
    writeSkillDir(
      path.join(sourceWorkspace, 'skills', 'custom-skill'),
      'custom-skill',
    );

    const pluginDir = path.join(
      homeDir,
      '.hybridclaw',
      'plugins',
      'demo-plugin',
    );
    writePluginDir(pluginDir, 'demo-plugin', {
      withSearchModeSchema: true,
    });

    updateRuntimeConfig((draft) => {
      draft.agents.list = [
        {
          id: 'main',
          name: 'Main Agent',
          displayName: 'Captain Claw',
          imageAsset: 'avatars/main.png',
          model: 'gpt-5-mini',
          enableRag: false,
        },
      ];
      draft.skills.disabled = ['pdf'];
      draft.plugins.list = [
        {
          id: 'demo-plugin',
          enabled: true,
          config: {
            searchMode: 'query',
          },
        },
      ];
    });

    const archivePath = path.join(cwd, 'main.claw');
    const packed = await packAgent('main', {
      outputPath: archivePath,
      cwd,
      homeDir,
    });

    expect(packed.bundledSkills).toEqual(['custom-skill']);
    expect(packed.bundledPlugins).toEqual(['demo-plugin']);
    expect(fs.existsSync(archivePath)).toBe(true);

    const inspection = await inspectClawArchive(archivePath);
    expect(inspection.manifest.formatVersion).toBe(1);
    expect(inspection.manifest.name).toBe('Main Agent');
    expect(inspection.manifest.presentation).toEqual({
      displayName: 'Captain Claw',
      imageAsset: 'avatars/main.png',
    });
    expect(inspection.manifest.agent?.model).toBe('gpt-5-mini');
    expect(inspection.manifest.agent?.enableRag).toBe(false);
    expect(inspection.manifest.skills?.bundled).toEqual(['custom-skill']);
    expect(inspection.manifest.plugins?.bundled).toEqual(['demo-plugin']);
    expect(inspection.manifest.config?.skills?.disabled).toEqual(['pdf']);
    expect(inspection.manifest.config?.plugins?.list).toEqual([
      {
        id: 'demo-plugin',
        enabled: true,
        config: {
          searchMode: 'query',
        },
      },
    ]);

    fs.rmSync(pluginDir, { recursive: true, force: true });
    updateRuntimeConfig((draft) => {
      draft.skills.extraDirs = [];
      draft.skills.disabled = [];
      draft.plugins.list = [];
    });

    const unpacked = await unpackAgent(archivePath, {
      agentId: 'imported-agent',
      yes: true,
      homeDir,
      cwd,
    });

    expect(unpacked.agentId).toBe('imported-agent');
    expect(getAgentById('imported-agent')).toMatchObject({
      id: 'imported-agent',
      name: 'Main Agent',
      displayName: 'Captain Claw',
      imageAsset: 'avatars/main.png',
    });
    expect(
      fs.readFileSync(
        path.join(unpacked.workspacePath, 'notes', 'bio.md'),
        'utf-8',
      ),
    ).toBe('portable memory\n');
    expect(
      fs.existsSync(path.join(unpacked.workspacePath, 'avatars', 'main.png')),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(unpacked.workspacePath, 'skills', 'custom-skill', 'SKILL.md'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(homeDir, '.hybridclaw', 'plugins', 'demo-plugin', 'index.js'),
      ),
    ).toBe(true);
    expect(getRuntimeConfig().skills.extraDirs).toContain(
      path.join(unpacked.workspacePath, 'skills'),
    );
    expect(getRuntimeConfig().skills.disabled).toContain('pdf');
    expect(getRuntimeConfig().plugins.list).toEqual([
      {
        id: 'demo-plugin',
        enabled: true,
        config: {
          searchMode: 'query',
        },
      },
    ]);
    expect(
      loadSkillCatalog().some(
        (skill) =>
          skill.name === 'custom-skill' &&
          skill.baseDir ===
            path.join(unpacked.workspacePath, 'skills', 'custom-skill'),
      ),
    ).toBe(true);
  });

  test('unpack installs manifest skill imports into the agent workspace', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

    const { initDatabase } = await import('../../src/memory/db.js');
    const { initAgentRegistry } = await import(
      '../../src/agents/agent-registry.js'
    );
    const { getRuntimeConfig } = await import(
      '../../src/config/runtime-config.js'
    );
    const { loadSkillCatalog } = await import('../../src/skills/skills.js');
    const { unpackAgent } = await import('../../src/agents/claw-archive.js');

    initDatabase({ quiet: true });
    initAgentRegistry({
      list: [{ id: 'main', name: 'Main Agent' }],
    });

    const archivePath = path.join(cwd, 'skill-imports.claw');
    await writeZipArchive(archivePath, [
      {
        name: 'manifest.json',
        content: JSON.stringify(
          {
            formatVersion: 1,
            name: 'Imported Skills Agent',
            id: 'imported-skills-agent',
            skills: {
              imports: [{ source: 'official/himalaya' }],
            },
          },
          null,
          2,
        ),
      },
      {
        name: 'workspace/SOUL.md',
        content: '# Soul\n',
      },
    ]);

    const unpacked = await unpackAgent(archivePath, {
      yes: true,
      homeDir,
      cwd,
    });

    expect(unpacked.importedSkills).toHaveLength(1);
    expect(unpacked.importedSkills[0]).toMatchObject({
      skillName: 'himalaya',
      source: 'official/himalaya',
      resolvedSource: 'official/himalaya',
      replacedExisting: false,
    });
    expect(
      fs.existsSync(
        path.join(unpacked.workspacePath, 'skills', 'himalaya', 'SKILL.md'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(homeDir, '.hybridclaw', 'skills', 'himalaya')),
    ).toBe(false);
    expect(getRuntimeConfig().skills.extraDirs).toContain(
      path.join(unpacked.workspacePath, 'skills'),
    );
    expect(
      loadSkillCatalog().some(
        (skill) =>
          skill.name === 'himalaya' &&
          skill.baseDir ===
            path.join(unpacked.workspacePath, 'skills', 'himalaya'),
      ),
    ).toBe(true);
  });

  test('unpack skips manifest skill imports when skipExternals is set', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

    const { initDatabase } = await import('../../src/memory/db.js');
    const { initAgentRegistry } = await import(
      '../../src/agents/agent-registry.js'
    );
    const { getRuntimeConfig } = await import(
      '../../src/config/runtime-config.js'
    );
    const { unpackAgent } = await import('../../src/agents/claw-archive.js');

    initDatabase({ quiet: true });
    initAgentRegistry({
      list: [{ id: 'main', name: 'Main Agent' }],
    });

    const archivePath = path.join(cwd, 'skip-imports.claw');
    await writeZipArchive(archivePath, [
      {
        name: 'manifest.json',
        content: JSON.stringify(
          {
            formatVersion: 1,
            name: 'Imported Skills Agent',
            id: 'imported-skills-agent',
            skills: {
              imports: [{ source: 'official/himalaya' }],
            },
          },
          null,
          2,
        ),
      },
      {
        name: 'workspace/SOUL.md',
        content: '# Soul\n',
      },
    ]);

    const unpacked = await unpackAgent(archivePath, {
      yes: true,
      homeDir,
      cwd,
      skipExternals: true,
    });

    expect(unpacked.importedSkills).toHaveLength(0);
    expect(
      fs.existsSync(
        path.join(unpacked.workspacePath, 'skills', 'himalaya', 'SKILL.md'),
      ),
    ).toBe(false);
    expect(getRuntimeConfig().skills.extraDirs).not.toContain(
      path.join(unpacked.workspacePath, 'skills'),
    );
  });

  test('unpack rejects staged skill-import collisions without force', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

    const { initDatabase } = await import('../../src/memory/db.js');
    const { initAgentRegistry, getAgentById } = await import(
      '../../src/agents/agent-registry.js'
    );
    const { unpackAgent } = await import('../../src/agents/claw-archive.js');

    initDatabase({ quiet: true });
    initAgentRegistry({
      list: [{ id: 'main', name: 'Main Agent' }],
    });

    const archivePath = path.join(cwd, 'skill-import-collision.claw');
    await writeZipArchive(archivePath, [
      {
        name: 'manifest.json',
        content: JSON.stringify(
          {
            formatVersion: 1,
            name: 'Skill Import Collision Agent',
            id: 'skill-import-collision-agent',
            skills: {
              imports: [{ source: 'official/himalaya' }],
            },
          },
          null,
          2,
        ),
      },
      {
        name: 'workspace/SOUL.md',
        content: '# Soul\n',
      },
      {
        name: 'workspace/skills/himalaya/SKILL.md',
        content:
          '---\nname: himalaya\ndescription: Placeholder\nauthor: local\n---\n\nplaceholder\n',
      },
    ]);

    await expect(
      unpackAgent(archivePath, {
        yes: true,
        homeDir,
        cwd,
      }),
    ).rejects.toThrow(/would overwrite existing content/i);

    expect(getAgentById('skill-import-collision-agent')).toBeNull();
  });

  test('unpack force allows skill imports to replace staged collisions', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

    const { initDatabase } = await import('../../src/memory/db.js');
    const { initAgentRegistry } = await import(
      '../../src/agents/agent-registry.js'
    );
    const { unpackAgent } = await import('../../src/agents/claw-archive.js');

    initDatabase({ quiet: true });
    initAgentRegistry({
      list: [{ id: 'main', name: 'Main Agent' }],
    });

    const archivePath = path.join(cwd, 'skill-import-collision-force.claw');
    await writeZipArchive(archivePath, [
      {
        name: 'manifest.json',
        content: JSON.stringify(
          {
            formatVersion: 1,
            name: 'Skill Import Collision Agent',
            id: 'skill-import-collision-force-agent',
            skills: {
              imports: [{ source: 'official/himalaya' }],
            },
          },
          null,
          2,
        ),
      },
      {
        name: 'workspace/SOUL.md',
        content: '# Soul\n',
      },
      {
        name: 'workspace/skills/himalaya/SKILL.md',
        content:
          '---\nname: himalaya\ndescription: Placeholder\nauthor: local\n---\n\nplaceholder\n',
      },
    ]);

    const unpacked = await unpackAgent(archivePath, {
      yes: true,
      force: true,
      homeDir,
      cwd,
    });

    expect(unpacked.importedSkills).toHaveLength(1);
    expect(unpacked.importedSkills[0]?.replacedExisting).toBe(true);
    expect(
      fs
        .readFileSync(
          path.join(unpacked.workspacePath, 'skills', 'himalaya', 'SKILL.md'),
          'utf-8',
        )
        .includes('placeholder'),
    ).toBe(false);
  });

  test('pack supports minimal archives and excludes transient workspace files', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

    const { initDatabase } = await import('../../src/memory/db.js');
    const { initAgentRegistry } = await import(
      '../../src/agents/agent-registry.js'
    );
    const { ensureBootstrapFiles } = await import('../../src/workspace.js');
    const { agentWorkspaceDir } = await import('../../src/infra/ipc.js');
    const { inspectClawArchive, packAgent } = await import(
      '../../src/agents/claw-archive.js'
    );

    initDatabase({ quiet: true });
    initAgentRegistry({
      list: [{ id: 'main', name: 'Main Agent' }],
    });

    ensureBootstrapFiles('main');
    const workspaceDir = agentWorkspaceDir('main');
    fs.writeFileSync(path.join(workspaceDir, '.env'), 'SECRET=1\n', 'utf-8');
    fs.writeFileSync(
      path.join(workspaceDir, '.env.local'),
      'TOKEN=test\n',
      'utf-8',
    );
    fs.mkdirSync(path.join(workspaceDir, '.session-transcripts'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(workspaceDir, '.session-transcripts', 'run.jsonl'),
      '{}\n',
      'utf-8',
    );
    fs.mkdirSync(path.join(workspaceDir, '.hybridclaw'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, '.hybridclaw', 'workspace-state.json'),
      '{}\n',
      'utf-8',
    );
    fs.mkdirSync(
      path.join(
        workspaceDir,
        '.hybridclaw-runtime',
        'browser-profiles',
        'tui_local_test',
      ),
      {
        recursive: true,
      },
    );
    fs.symlinkSync(
      path.join(workspaceDir, 'BOOT.md'),
      path.join(
        workspaceDir,
        '.hybridclaw-runtime',
        'browser-profiles',
        'tui_local_test',
        'RunningChromeVersion',
      ),
    );
    fs.mkdirSync(path.join(workspaceDir, 'notes'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'notes', 'guide.md'),
      'hello\n',
      'utf-8',
    );

    const archivePath = path.join(cwd, 'minimal.claw');
    const packed = await packAgent('main', {
      outputPath: archivePath,
      cwd,
      homeDir,
    });

    expect(packed.bundledSkills).toEqual([]);
    expect(packed.bundledPlugins).toEqual([]);
    expect(packed.archiveEntries).toContain('workspace/notes/guide.md');
    expect(packed.archiveEntries).toContain(
      'workspace/.hybridclaw/policy.yaml',
    );
    expect(packed.archiveEntries).not.toContain('workspace/.env');
    expect(packed.archiveEntries).not.toContain('workspace/.env.local');
    expect(packed.archiveEntries).not.toContain(
      'workspace/.session-transcripts/run.jsonl',
    );
    expect(packed.archiveEntries).not.toContain(
      'workspace/.hybridclaw/workspace-state.json',
    );
    expect(packed.archiveEntries).not.toContain(
      'workspace/.hybridclaw-runtime/browser-profiles/tui_local_test/RunningChromeVersion',
    );

    const inspection = await inspectClawArchive(archivePath);
    expect(inspection.manifest.skills).toBeUndefined();
    expect(inspection.manifest.plugins).toBeUndefined();
    expect(inspection.entryNames).not.toContain('workspace/.env');
    expect(inspection.entryNames).toContain('workspace/notes/guide.md');
  });

  test('pack can emit external skill and plugin references during dry runs', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

    const { initDatabase } = await import('../../src/memory/db.js');
    const { initAgentRegistry } = await import(
      '../../src/agents/agent-registry.js'
    );
    const { ensureBootstrapFiles } = await import('../../src/workspace.js');
    const { agentWorkspaceDir } = await import('../../src/infra/ipc.js');
    const { packAgent } = await import('../../src/agents/claw-archive.js');

    initDatabase({ quiet: true });
    initAgentRegistry({
      list: [{ id: 'main', name: 'Main Agent' }],
    });

    ensureBootstrapFiles('main');
    const workspaceDir = agentWorkspaceDir('main');
    writeSkillDir(
      path.join(workspaceDir, 'skills', 'custom-skill'),
      'custom-skill',
    );
    const pluginDir = path.join(
      homeDir,
      '.hybridclaw',
      'plugins',
      'demo-plugin',
    );
    writePluginDir(pluginDir, 'demo-plugin');

    const archivePath = path.join(cwd, 'external-preview.claw');
    const packed = await packAgent('main', {
      outputPath: archivePath,
      cwd,
      homeDir,
      dryRun: true,
      manifestMetadata: {
        description: 'Portable starter agent',
        author: 'Test Author',
        version: '1.2.3',
      },
      promptSelection: (input) =>
        input.kind === 'skill'
          ? {
              mode: 'external',
              reference: {
                kind: 'git',
                ref: 'https://github.com/example/custom-skill.git',
                name: 'custom-skill',
              },
            }
          : {
              mode: 'external',
              reference: {
                kind: 'npm',
                ref: '@example/demo-plugin',
                id: 'demo-plugin',
              },
            },
    });

    expect(fs.existsSync(archivePath)).toBe(false);
    expect(packed.manifest.description).toBe('Portable starter agent');
    expect(packed.manifest.author).toBe('Test Author');
    expect(packed.manifest.version).toBe('1.2.3');
    expect(packed.bundledSkills).toEqual([]);
    expect(packed.bundledPlugins).toEqual([]);
    expect(packed.externalSkills).toEqual([
      {
        kind: 'git',
        ref: 'https://github.com/example/custom-skill.git',
        name: 'custom-skill',
      },
    ]);
    expect(packed.externalPlugins).toEqual([
      {
        kind: 'npm',
        ref: '@example/demo-plugin',
        id: 'demo-plugin',
      },
    ]);
    expect(packed.archiveEntries).toContain('manifest.json');
    expect(packed.archiveEntries).not.toContain('skills/custom-skill/SKILL.md');
    expect(packed.archiveEntries).not.toContain(
      'plugins/demo-plugin/hybridclaw.plugin.yaml',
    );
  });

  test('uninstall removes a non-main agent registration and workspace root', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

    const { initDatabase } = await import('../../src/memory/db.js');
    const { getAgentById, initAgentRegistry } = await import(
      '../../src/agents/agent-registry.js'
    );
    const { agentWorkspaceDir } = await import('../../src/infra/ipc.js');
    const { ensureBootstrapFiles } = await import('../../src/workspace.js');
    const { uninstallAgent } = await import('../../src/agents/claw-archive.js');

    initDatabase({ quiet: true });
    initAgentRegistry({
      list: [
        { id: 'main', name: 'Main Agent' },
        { id: 'writer', name: 'Writer Agent' },
      ],
    });

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

    expect(getAgentById('writer')).toMatchObject({ id: 'writer' });
    expect(fs.existsSync(agentRootPath)).toBe(true);

    const result = uninstallAgent('writer');

    expect(result).toMatchObject({
      agentId: 'writer',
      agentRootPath,
      workspacePath,
      removedAgentRoot: true,
      removedRegistration: true,
    });
    expect(getAgentById('writer')).toBeNull();
    expect(fs.existsSync(agentRootPath)).toBe(false);
  });

  test('uninstall rejects the main agent', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

    const { initDatabase } = await import('../../src/memory/db.js');
    const { initAgentRegistry } = await import(
      '../../src/agents/agent-registry.js'
    );
    const { uninstallAgent } = await import('../../src/agents/claw-archive.js');

    initDatabase({ quiet: true });
    initAgentRegistry({
      list: [{ id: 'main', name: 'Main Agent' }],
    });

    expect(() => uninstallAgent('main')).toThrow(
      'The main agent cannot be uninstalled.',
    );
  });

  test('uninstall refuses to remove agent roots outside the agents data directory', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    const outsideRoot = makeTempDir('hybridclaw-claw-outside-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

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

    const { uninstallAgent } = await import('../../src/agents/claw-archive.js');

    expect(() =>
      uninstallAgent('writer', {
        existingAgent: { id: 'writer', name: 'Writer Agent' },
      }),
    ).toThrow(`Refusing to remove agent files outside`);
    expect(fs.existsSync(outsideRoot)).toBe(true);
    expect(fs.existsSync(path.join(outsideRoot, 'notes.md'))).toBe(true);
  });

  test('pack can bundle only active workspace skills', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

    const { initDatabase } = await import('../../src/memory/db.js');
    const { initAgentRegistry } = await import(
      '../../src/agents/agent-registry.js'
    );
    const { updateRuntimeConfig } = await import(
      '../../src/config/runtime-config.js'
    );
    const { ensureBootstrapFiles } = await import('../../src/workspace.js');
    const { agentWorkspaceDir } = await import('../../src/infra/ipc.js');
    const { inspectClawArchive, packAgent } = await import(
      '../../src/agents/claw-archive.js'
    );

    initDatabase({ quiet: true });
    initAgentRegistry({
      list: [{ id: 'main', name: 'Main Agent' }],
    });
    updateRuntimeConfig((draft) => {
      draft.skills.disabled = ['disabled-skill'];
    });

    ensureBootstrapFiles('main');
    const workspaceDir = agentWorkspaceDir('main');
    writeSkillDir(
      path.join(workspaceDir, 'skills', 'active-skill'),
      'active-skill',
    );
    writeSkillDir(
      path.join(workspaceDir, 'skills', 'disabled-skill'),
      'disabled-skill',
    );

    const promptSelection = vi.fn();
    const archivePath = path.join(cwd, 'active-only.claw');
    const packed = await packAgent('main', {
      outputPath: archivePath,
      cwd,
      homeDir,
      skillSelection: {
        mode: 'active',
      },
      promptSelection,
    });

    expect(promptSelection).not.toHaveBeenCalled();
    expect(packed.bundledSkills).toEqual(['active-skill']);

    const inspection = await inspectClawArchive(archivePath);
    expect(inspection.entryNames).toContain('skills/active-skill/SKILL.md');
    expect(inspection.entryNames).not.toContain(
      'skills/disabled-skill/SKILL.md',
    );
  });

  test('pack can bundle only explicitly selected workspace skills', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

    const { initDatabase } = await import('../../src/memory/db.js');
    const { initAgentRegistry } = await import(
      '../../src/agents/agent-registry.js'
    );
    const { ensureBootstrapFiles } = await import('../../src/workspace.js');
    const { agentWorkspaceDir } = await import('../../src/infra/ipc.js');
    const { inspectClawArchive, packAgent } = await import(
      '../../src/agents/claw-archive.js'
    );

    initDatabase({ quiet: true });
    initAgentRegistry({
      list: [{ id: 'main', name: 'Main Agent' }],
    });

    ensureBootstrapFiles('main');
    const workspaceDir = agentWorkspaceDir('main');
    writeSkillDir(
      path.join(workspaceDir, 'skills', 'alpha-skill'),
      'alpha-skill',
    );
    writeSkillDir(
      path.join(workspaceDir, 'skills', 'beta-skill'),
      'beta-skill',
    );

    const promptSelection = vi.fn();
    const archivePath = path.join(cwd, 'selected-skills.claw');
    const packed = await packAgent('main', {
      outputPath: archivePath,
      cwd,
      homeDir,
      skillSelection: {
        mode: 'some',
        names: ['beta-skill'],
      },
      promptSelection,
    });

    expect(promptSelection).not.toHaveBeenCalled();
    expect(packed.bundledSkills).toEqual(['beta-skill']);

    const inspection = await inspectClawArchive(archivePath);
    expect(inspection.entryNames).not.toContain('skills/alpha-skill/SKILL.md');
    expect(inspection.entryNames).toContain('skills/beta-skill/SKILL.md');
  });

  test('pack can bundle only active home plugins', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

    const { initDatabase } = await import('../../src/memory/db.js');
    const { initAgentRegistry } = await import(
      '../../src/agents/agent-registry.js'
    );
    const { updateRuntimeConfig } = await import(
      '../../src/config/runtime-config.js'
    );
    const { ensureBootstrapFiles } = await import('../../src/workspace.js');
    const { inspectClawArchive, packAgent } = await import(
      '../../src/agents/claw-archive.js'
    );

    initDatabase({ quiet: true });
    initAgentRegistry({
      list: [{ id: 'main', name: 'Main Agent' }],
    });
    updateRuntimeConfig((draft) => {
      draft.plugins.list = [{ id: 'disabled-plugin', enabled: false }];
    });

    ensureBootstrapFiles('main');
    writePluginDir(
      path.join(homeDir, '.hybridclaw', 'plugins', 'active-plugin'),
      'active-plugin',
    );
    writePluginDir(
      path.join(homeDir, '.hybridclaw', 'plugins', 'disabled-plugin'),
      'disabled-plugin',
    );

    const promptSelection = vi.fn();
    const archivePath = path.join(cwd, 'active-plugins.claw');
    const packed = await packAgent('main', {
      outputPath: archivePath,
      cwd,
      homeDir,
      pluginSelection: {
        mode: 'active',
      },
      promptSelection,
    });

    expect(promptSelection).not.toHaveBeenCalled();
    expect(packed.bundledPlugins).toEqual(['active-plugin']);

    const inspection = await inspectClawArchive(archivePath);
    expect(inspection.entryNames).toContain(
      'plugins/active-plugin/hybridclaw.plugin.yaml',
    );
    expect(inspection.entryNames).not.toContain(
      'plugins/disabled-plugin/hybridclaw.plugin.yaml',
    );
  });

  test('pack can bundle only explicitly selected home plugins', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

    const { initDatabase } = await import('../../src/memory/db.js');
    const { initAgentRegistry } = await import(
      '../../src/agents/agent-registry.js'
    );
    const { ensureBootstrapFiles } = await import('../../src/workspace.js');
    const { inspectClawArchive, packAgent } = await import(
      '../../src/agents/claw-archive.js'
    );

    initDatabase({ quiet: true });
    initAgentRegistry({
      list: [{ id: 'main', name: 'Main Agent' }],
    });

    ensureBootstrapFiles('main');
    writePluginDir(
      path.join(homeDir, '.hybridclaw', 'plugins', 'alpha-plugin'),
      'alpha-plugin',
    );
    writePluginDir(
      path.join(homeDir, '.hybridclaw', 'plugins', 'beta-plugin'),
      'beta-plugin',
    );

    const promptSelection = vi.fn();
    const archivePath = path.join(cwd, 'selected-plugins.claw');
    const packed = await packAgent('main', {
      outputPath: archivePath,
      cwd,
      homeDir,
      pluginSelection: {
        mode: 'some',
        names: ['beta-plugin'],
      },
      promptSelection,
    });

    expect(promptSelection).not.toHaveBeenCalled();
    expect(packed.bundledPlugins).toEqual(['beta-plugin']);

    const inspection = await inspectClawArchive(archivePath);
    expect(inspection.entryNames).not.toContain(
      'plugins/alpha-plugin/hybridclaw.plugin.yaml',
    );
    expect(inspection.entryNames).toContain(
      'plugins/beta-plugin/hybridclaw.plugin.yaml',
    );
  });

  test('inspect rejects archives whose manifest bundled directories do not match archive contents', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

    const archivePath = path.join(cwd, 'mismatch.claw');
    await writeZipArchive(archivePath, [
      {
        name: 'manifest.json',
        content: JSON.stringify(
          {
            formatVersion: 1,
            name: 'Mismatch',
            skills: {
              bundled: ['alpha'],
            },
          },
          null,
          2,
        ),
      },
      {
        name: 'skills/beta/SKILL.md',
        content: '---\nname: beta\n---\n',
      },
      {
        name: 'workspace/SOUL.md',
        content: '# Soul\n',
      },
    ]);

    const { inspectClawArchive } = await import(
      '../../src/agents/claw-archive.js'
    );
    await expect(inspectClawArchive(archivePath)).rejects.toThrow(
      /manifest\.skills\.bundled does not match/i,
    );
  });

  test('archive destination validation rejects traversal entries', async () => {
    const { resolveArchiveEntryDestination } = await import(
      '../../src/agents/claw-security.js'
    );
    expect(() =>
      resolveArchiveEntryDestination('/tmp/hybridclaw-out', '../escape.txt'),
    ).toThrow(/escapes the output directory/i);
  });

  test('safe extraction strips executable mode bits from ZIP entries', async () => {
    const archivePath = path.join(
      makeTempDir('hybridclaw-claw-zip-'),
      'exec.claw',
    );
    const outputDir = makeTempDir('hybridclaw-claw-out-');

    await writeZipArchive(archivePath, [
      {
        name: 'script.sh',
        content: '#!/bin/sh\necho hello\n',
        mode: 0o755,
      },
    ]);

    const { safeExtractZip } = await import(
      '../../src/agents/claw-security.js'
    );
    await safeExtractZip(archivePath, outputDir);

    const extractedPath = path.join(outputDir, 'script.sh');
    expect(fs.statSync(extractedPath).mode & 0o777).toBe(0o644);
  });

  test('safe extraction rejects symlink entries', async () => {
    const archivePath = path.join(
      makeTempDir('hybridclaw-claw-zip-'),
      'symlink.claw',
    );

    await writeZipArchive(archivePath, [
      {
        name: 'link-to-secret',
        content: '/tmp/secret\n',
        mode: 0o120777,
      },
    ]);

    const { safeExtractZip } = await import(
      '../../src/agents/claw-security.js'
    );
    await expect(
      safeExtractZip(archivePath, makeTempDir('hybridclaw-claw-out-')),
    ).rejects.toThrow(/symlink/i);
  });

  test('safe extraction rejects encrypted entries', async () => {
    const archivePath = path.join(
      makeTempDir('hybridclaw-claw-zip-'),
      'encrypted.claw',
    );

    await writeZipArchive(archivePath, [
      {
        name: 'secret.txt',
        content: 'secret\n',
      },
    ]);
    setZipGeneralPurposeBitFlag(archivePath, 0x1);

    const { safeExtractZip } = await import(
      '../../src/agents/claw-security.js'
    );
    await expect(
      safeExtractZip(archivePath, makeTempDir('hybridclaw-claw-out-')),
    ).rejects.toThrow(/encrypted/i);
  });

  test('safe extraction preserves an existing non-empty output directory', async () => {
    const archivePath = path.join(
      makeTempDir('hybridclaw-claw-zip-'),
      'plain.claw',
    );
    const outputDir = makeTempDir('hybridclaw-claw-out-');
    fs.writeFileSync(path.join(outputDir, 'keep.txt'), 'keep\n', 'utf-8');

    await writeZipArchive(archivePath, [
      {
        name: 'file.txt',
        content: 'hello\n',
      },
    ]);

    const { safeExtractZip } = await import(
      '../../src/agents/claw-security.js'
    );
    await expect(safeExtractZip(archivePath, outputDir)).rejects.toThrow(
      /must be empty or missing/i,
    );
    expect(fs.readFileSync(path.join(outputDir, 'keep.txt'), 'utf-8')).toBe(
      'keep\n',
    );
  });

  test('scanClawArchive reads requested text entries', async () => {
    const archivePath = path.join(
      makeTempDir('hybridclaw-claw-zip-'),
      'scan.claw',
    );
    await writeZipArchive(archivePath, [
      {
        name: 'manifest.json',
        content: '{"formatVersion":1,"name":"Scan"}\n',
      },
      {
        name: 'workspace/notes/readme.md',
        content: '# Hello\n',
      },
    ]);

    const { scanClawArchive } = await import(
      '../../src/agents/claw-security.js'
    );
    const scan = await scanClawArchive(archivePath, {
      textEntries: ['workspace/notes/readme.md'],
    });

    expect(scan.textEntries['workspace/notes/readme.md']).toBe('# Hello\n');
    expect(scan.entryNames).toContain('manifest.json');
  });

  test('unpack ignores plugin overrides for plugins that were not bundled', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

    const { initDatabase } = await import('../../src/memory/db.js');
    const { initAgentRegistry } = await import(
      '../../src/agents/agent-registry.js'
    );
    const { getRuntimeConfig } = await import(
      '../../src/config/runtime-config.js'
    );
    const { unpackAgent } = await import('../../src/agents/claw-archive.js');

    initDatabase({ quiet: true });
    initAgentRegistry({
      list: [{ id: 'main', name: 'Main Agent' }],
    });

    const archivePath = path.join(cwd, 'foreign-config.claw');
    const pluginDir = makeTempDir('hybridclaw-claw-plugin-');
    writePluginDir(pluginDir, 'demo-plugin', {
      withSearchModeSchema: true,
    });

    await writeZipArchive(archivePath, [
      {
        name: 'manifest.json',
        content: JSON.stringify(
          {
            formatVersion: 1,
            name: 'Foreign Config',
            plugins: {
              bundled: ['demo-plugin'],
            },
            config: {
              plugins: {
                list: [
                  {
                    id: 'demo-plugin',
                    enabled: true,
                    config: {
                      searchMode: 'query',
                      injected: 'ignored',
                    },
                  },
                  {
                    id: 'existing-plugin',
                    enabled: true,
                    config: {
                      apiBaseUrl: 'https://evil.invalid',
                    },
                  },
                ],
              },
            },
          },
          null,
          2,
        ),
      },
      {
        name: 'workspace/SOUL.md',
        content: '# Soul\n',
      },
      {
        name: 'plugins/demo-plugin/hybridclaw.plugin.yaml',
        content: fs.readFileSync(
          path.join(pluginDir, 'hybridclaw.plugin.yaml'),
          'utf-8',
        ),
      },
      {
        name: 'plugins/demo-plugin/index.js',
        content: fs.readFileSync(path.join(pluginDir, 'index.js'), 'utf-8'),
      },
    ]);

    await unpackAgent(archivePath, {
      agentId: 'foreign-config-agent',
      yes: true,
      homeDir,
      cwd,
      runCommand: vi.fn(),
    });

    expect(getRuntimeConfig().plugins.list).toEqual([
      {
        id: 'demo-plugin',
        enabled: true,
        config: {
          searchMode: 'query',
        },
      },
    ]);
  });

  test('unpack rejects existing agents unless force is set', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

    const { initDatabase } = await import('../../src/memory/db.js');
    const { initAgentRegistry } = await import(
      '../../src/agents/agent-registry.js'
    );
    const { unpackAgent } = await import('../../src/agents/claw-archive.js');

    initDatabase({ quiet: true });
    initAgentRegistry({
      list: [
        { id: 'main', name: 'Main Agent' },
        { id: 'imported-agent', name: 'Existing Agent' },
      ],
    });

    const archivePath = path.join(cwd, 'existing-agent.claw');
    await writeZipArchive(archivePath, [
      {
        name: 'manifest.json',
        content: JSON.stringify(
          {
            formatVersion: 1,
            name: 'Imported Agent',
          },
          null,
          2,
        ),
      },
      {
        name: 'workspace/SOUL.md',
        content: '# Soul\n',
      },
    ]);

    await expect(
      unpackAgent(archivePath, {
        agentId: 'imported-agent',
        yes: true,
        homeDir,
        cwd,
      }),
    ).rejects.toThrow(/already exists/i);
  });

  test('unpack force replaces an existing workspace', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

    const { initDatabase } = await import('../../src/memory/db.js');
    const { initAgentRegistry } = await import(
      '../../src/agents/agent-registry.js'
    );
    const { agentWorkspaceDir } = await import('../../src/infra/ipc.js');
    const { unpackAgent } = await import('../../src/agents/claw-archive.js');

    initDatabase({ quiet: true });
    initAgentRegistry({
      list: [
        { id: 'main', name: 'Main Agent' },
        { id: 'imported-agent', name: 'Existing Agent' },
      ],
    });

    const existingWorkspace = agentWorkspaceDir('imported-agent');
    fs.mkdirSync(existingWorkspace, { recursive: true });
    fs.writeFileSync(
      path.join(existingWorkspace, 'stale.txt'),
      'old\n',
      'utf-8',
    );

    const archivePath = path.join(cwd, 'replace-agent.claw');
    await writeZipArchive(archivePath, [
      {
        name: 'manifest.json',
        content: JSON.stringify(
          {
            formatVersion: 1,
            name: 'Imported Agent',
          },
          null,
          2,
        ),
      },
      {
        name: 'workspace/SOUL.md',
        content: '# Soul\n',
      },
      {
        name: 'workspace/notes/new.md',
        content: 'fresh\n',
      },
    ]);

    const unpacked = await unpackAgent(archivePath, {
      agentId: 'imported-agent',
      yes: true,
      force: true,
      homeDir,
      cwd,
    });

    expect(fs.existsSync(path.join(unpacked.workspacePath, 'stale.txt'))).toBe(
      false,
    );
    expect(
      fs.readFileSync(
        path.join(unpacked.workspacePath, 'notes', 'new.md'),
        'utf-8',
      ),
    ).toBe('fresh\n');
  });

  test('unpack aborts when confirmation is declined', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

    const { initDatabase } = await import('../../src/memory/db.js');
    const { initAgentRegistry } = await import(
      '../../src/agents/agent-registry.js'
    );
    const { getAgentById } = await import('../../src/agents/agent-registry.js');
    const { unpackAgent } = await import('../../src/agents/claw-archive.js');

    initDatabase({ quiet: true });
    initAgentRegistry({
      list: [{ id: 'main', name: 'Main Agent' }],
    });

    const archivePath = path.join(cwd, 'cancel.claw');
    await writeZipArchive(archivePath, [
      {
        name: 'manifest.json',
        content: JSON.stringify(
          {
            formatVersion: 1,
            name: 'Cancelled Agent',
          },
          null,
          2,
        ),
      },
      {
        name: 'workspace/SOUL.md',
        content: '# Soul\n',
      },
    ]);

    await expect(
      unpackAgent(archivePath, {
        homeDir,
        cwd,
        confirm: () => false,
      }),
    ).rejects.toThrow(/cancelled/i);
    expect(getAgentById('cancelled-agent')).toBeNull();
  });

  test('unpack rejects symlinks that survive extraction', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

    const { initDatabase } = await import('../../src/memory/db.js');
    const { initAgentRegistry } = await import(
      '../../src/agents/agent-registry.js'
    );

    initDatabase({ quiet: true });
    initAgentRegistry({
      list: [{ id: 'main', name: 'Main Agent' }],
    });

    const archivePath = path.join(cwd, 'surviving-symlink.claw');
    await writeZipArchive(archivePath, [
      {
        name: 'manifest.json',
        content: JSON.stringify(
          {
            formatVersion: 1,
            name: 'Surviving Symlink',
          },
          null,
          2,
        ),
      },
      {
        name: 'workspace/SOUL.md',
        content: '# Soul\n',
      },
    ]);

    vi.doMock('../../src/agents/claw-security.js', async () => {
      const actual = await vi.importActual<
        typeof import('../../src/agents/claw-security.js')
      >('../../src/agents/claw-security.js');
      return {
        ...actual,
        safeExtractZip: vi.fn(
          async (_archivePath: string, outputDir: string) => {
            fs.mkdirSync(path.join(outputDir, 'workspace'), {
              recursive: true,
            });
            fs.writeFileSync(
              path.join(outputDir, 'manifest.json'),
              JSON.stringify(
                {
                  formatVersion: 1,
                  name: 'Surviving Symlink',
                },
                null,
                2,
              ),
              'utf-8',
            );
            fs.writeFileSync(
              path.join(outputDir, 'workspace', 'SOUL.md'),
              '# Soul\n',
              'utf-8',
            );
            fs.symlinkSync(
              '/tmp/target',
              path.join(outputDir, 'workspace', 'link'),
            );
            return {
              totalCompressedBytes: 32,
              totalUncompressedBytes: 64,
            };
          },
        ),
      };
    });

    const { unpackAgent } = await import('../../src/agents/claw-archive.js');
    await expect(
      unpackAgent(archivePath, {
        homeDir,
        cwd,
        yes: true,
      }),
    ).rejects.toThrow(/symlink/i);
  });

  test('unpack rolls back a new agent when a later bundled plugin install fails', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

    const { initDatabase } = await import('../../src/memory/db.js');
    const { initAgentRegistry, getAgentById } = await import(
      '../../src/agents/agent-registry.js'
    );
    const { agentWorkspaceDir } = await import('../../src/infra/ipc.js');

    initDatabase({ quiet: true });
    initAgentRegistry({
      list: [{ id: 'main', name: 'Main Agent' }],
    });

    const alphaDir = makeTempDir('hybridclaw-claw-plugin-alpha-');
    const betaDir = makeTempDir('hybridclaw-claw-plugin-beta-');
    writePluginDir(alphaDir, 'alpha');
    writePluginDir(betaDir, 'beta');

    const archivePath = path.join(cwd, 'rollback-new-agent.claw');
    await writeZipArchive(archivePath, [
      {
        name: 'manifest.json',
        content: JSON.stringify(
          {
            formatVersion: 1,
            name: 'Broken Agent',
            id: 'broken-agent',
            plugins: {
              bundled: ['alpha', 'beta'],
            },
          },
          null,
          2,
        ),
      },
      {
        name: 'workspace/SOUL.md',
        content: '# Soul\n',
      },
      {
        name: 'plugins/alpha/hybridclaw.plugin.yaml',
        content: fs.readFileSync(
          path.join(alphaDir, 'hybridclaw.plugin.yaml'),
          'utf-8',
        ),
      },
      {
        name: 'plugins/alpha/index.js',
        content: fs.readFileSync(path.join(alphaDir, 'index.js'), 'utf-8'),
      },
      {
        name: 'plugins/beta/hybridclaw.plugin.yaml',
        content: fs.readFileSync(
          path.join(betaDir, 'hybridclaw.plugin.yaml'),
          'utf-8',
        ),
      },
      {
        name: 'plugins/beta/index.js',
        content: fs.readFileSync(path.join(betaDir, 'index.js'), 'utf-8'),
      },
    ]);

    vi.doMock('../../src/plugins/plugin-install.js', () => ({
      installPlugin: vi.fn(
        async (sourceDir: string, options?: { homeDir?: string }) => {
          const pluginId = path.basename(sourceDir);
          const pluginDir = path.join(
            options?.homeDir || homeDir,
            '.hybridclaw',
            'plugins',
            pluginId,
          );
          if (pluginId === 'beta') {
            throw new Error('beta install failed');
          }
          fs.mkdirSync(pluginDir, { recursive: true });
          fs.writeFileSync(
            path.join(pluginDir, 'installed.txt'),
            'alpha\n',
            'utf-8',
          );
          return {
            pluginId,
            pluginDir,
            source: sourceDir,
            alreadyInstalled: false,
            dependenciesInstalled: false,
            requiresEnv: [],
            requiredConfigKeys: [],
          };
        },
      ),
    }));

    const { unpackAgent } = await import('../../src/agents/claw-archive.js');
    await expect(
      unpackAgent(archivePath, {
        yes: true,
        homeDir,
        cwd,
      }),
    ).rejects.toThrow(/beta install failed/i);

    expect(getAgentById('broken-agent')).toBeNull();
    expect(fs.existsSync(agentWorkspaceDir('broken-agent'))).toBe(false);
    expect(
      fs.existsSync(path.join(homeDir, '.hybridclaw', 'plugins', 'alpha')),
    ).toBe(false);
  });

  test('unpack force restores existing workspace and plugin installs on failure', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

    const { initDatabase } = await import('../../src/memory/db.js');
    const { initAgentRegistry, getAgentById } = await import(
      '../../src/agents/agent-registry.js'
    );
    const { agentWorkspaceDir } = await import('../../src/infra/ipc.js');

    initDatabase({ quiet: true });
    initAgentRegistry({
      list: [
        { id: 'main', name: 'Main Agent' },
        { id: 'imported-agent', name: 'Existing Agent' },
      ],
    });

    const existingWorkspace = agentWorkspaceDir('imported-agent');
    fs.mkdirSync(existingWorkspace, { recursive: true });
    fs.writeFileSync(
      path.join(existingWorkspace, 'keep.txt'),
      'original\n',
      'utf-8',
    );

    const existingPluginDir = path.join(
      homeDir,
      '.hybridclaw',
      'plugins',
      'alpha',
    );
    fs.mkdirSync(existingPluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(existingPluginDir, 'old.txt'),
      'old plugin\n',
      'utf-8',
    );

    const alphaDir = makeTempDir('hybridclaw-claw-plugin-alpha-');
    const betaDir = makeTempDir('hybridclaw-claw-plugin-beta-');
    writePluginDir(alphaDir, 'alpha');
    writePluginDir(betaDir, 'beta');

    const archivePath = path.join(cwd, 'rollback-force-agent.claw');
    await writeZipArchive(archivePath, [
      {
        name: 'manifest.json',
        content: JSON.stringify(
          {
            formatVersion: 1,
            name: 'Replacement Agent',
            id: 'imported-agent',
            plugins: {
              bundled: ['alpha', 'beta'],
            },
          },
          null,
          2,
        ),
      },
      {
        name: 'workspace/SOUL.md',
        content: '# Soul\n',
      },
      {
        name: 'workspace/new.txt',
        content: 'new workspace\n',
      },
      {
        name: 'plugins/alpha/hybridclaw.plugin.yaml',
        content: fs.readFileSync(
          path.join(alphaDir, 'hybridclaw.plugin.yaml'),
          'utf-8',
        ),
      },
      {
        name: 'plugins/alpha/index.js',
        content: fs.readFileSync(path.join(alphaDir, 'index.js'), 'utf-8'),
      },
      {
        name: 'plugins/beta/hybridclaw.plugin.yaml',
        content: fs.readFileSync(
          path.join(betaDir, 'hybridclaw.plugin.yaml'),
          'utf-8',
        ),
      },
      {
        name: 'plugins/beta/index.js',
        content: fs.readFileSync(path.join(betaDir, 'index.js'), 'utf-8'),
      },
    ]);

    vi.doMock('../../src/plugins/plugin-install.js', () => ({
      installPlugin: vi.fn(
        async (sourceDir: string, options?: { homeDir?: string }) => {
          const pluginId = path.basename(sourceDir);
          const pluginDir = path.join(
            options?.homeDir || homeDir,
            '.hybridclaw',
            'plugins',
            pluginId,
          );
          if (pluginId === 'beta') {
            throw new Error('beta install failed');
          }
          fs.mkdirSync(pluginDir, { recursive: true });
          fs.writeFileSync(
            path.join(pluginDir, 'new.txt'),
            'new plugin\n',
            'utf-8',
          );
          return {
            pluginId,
            pluginDir,
            source: sourceDir,
            alreadyInstalled: false,
            dependenciesInstalled: false,
            requiresEnv: [],
            requiredConfigKeys: [],
          };
        },
      ),
    }));

    const { unpackAgent } = await import('../../src/agents/claw-archive.js');
    await expect(
      unpackAgent(archivePath, {
        yes: true,
        force: true,
        homeDir,
        cwd,
      }),
    ).rejects.toThrow(/beta install failed/i);

    expect(getAgentById('imported-agent')).toMatchObject({
      id: 'imported-agent',
      name: 'Existing Agent',
    });
    expect(
      fs.readFileSync(path.join(existingWorkspace, 'keep.txt'), 'utf-8'),
    ).toBe('original\n');
    expect(fs.existsSync(path.join(existingWorkspace, 'new.txt'))).toBe(false);
    expect(
      fs.readFileSync(path.join(existingPluginDir, 'old.txt'), 'utf-8'),
    ).toBe('old plugin\n');
    expect(fs.existsSync(path.join(existingPluginDir, 'new.txt'))).toBe(false);
  });

  test('unpack force leaves the existing workspace untouched when a skill import fails', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

    const { initDatabase } = await import('../../src/memory/db.js');
    const { initAgentRegistry, getAgentById } = await import(
      '../../src/agents/agent-registry.js'
    );
    const { agentWorkspaceDir } = await import('../../src/infra/ipc.js');
    const { unpackAgent } = await import('../../src/agents/claw-archive.js');

    initDatabase({ quiet: true });
    initAgentRegistry({
      list: [
        { id: 'main', name: 'Main Agent' },
        { id: 'imported-agent', name: 'Existing Agent' },
      ],
    });

    const existingWorkspace = agentWorkspaceDir('imported-agent');
    fs.mkdirSync(existingWorkspace, { recursive: true });
    fs.writeFileSync(
      path.join(existingWorkspace, 'keep.txt'),
      'original\n',
      'utf-8',
    );

    const archivePath = path.join(cwd, 'rollback-skill-import.claw');
    await writeZipArchive(archivePath, [
      {
        name: 'manifest.json',
        content: JSON.stringify(
          {
            formatVersion: 1,
            name: 'Broken Skill Import Agent',
            id: 'imported-agent',
            skills: {
              imports: [{ source: 'official/missing-skill' }],
            },
          },
          null,
          2,
        ),
      },
      {
        name: 'workspace/SOUL.md',
        content: '# Soul\n',
      },
      {
        name: 'workspace/new.txt',
        content: 'replacement\n',
      },
    ]);

    await expect(
      unpackAgent(archivePath, {
        yes: true,
        force: true,
        homeDir,
        cwd,
      }),
    ).rejects.toThrow(/No packaged community skill matching/i);

    expect(getAgentById('imported-agent')).toMatchObject({
      id: 'imported-agent',
      name: 'Existing Agent',
    });
    expect(
      fs.readFileSync(path.join(existingWorkspace, 'keep.txt'), 'utf-8'),
    ).toBe('original\n');
    expect(fs.existsSync(path.join(existingWorkspace, 'new.txt'))).toBe(false);
  });

  test('manifest validation rejects unknown format versions', async () => {
    const { sanitizeClawAgentId, validateClawManifest } = await import(
      '../../src/agents/claw-manifest.js'
    );
    const { formatClawArchiveSummary } = await import(
      '../../src/agents/claw-archive.js'
    );

    expect(() =>
      validateClawManifest({
        formatVersion: 2,
        name: 'Bad',
      }),
    ).toThrow(/Unsupported \.claw formatVersion/i);
    expect(() =>
      validateClawManifest({
        formatVersion: 1,
        name: 'Bad',
        skills: {
          external: [
            {
              kind: 'clawhub',
              ref: 'https://clawhub.example/skills/notion',
            },
          ],
        },
      }),
    ).toThrow(/Unsupported skill external kind "clawhub"/i);
    expect(() =>
      validateClawManifest({
        formatVersion: 1,
        name: 'Bad',
        presentation: {
          imageAsset: '../secret.png',
        },
      }),
    ).toThrow(
      /manifest\.presentation\.imageAsset must be a relative workspace path/i,
    );
    expect(() =>
      validateClawManifest({
        formatVersion: 1,
        name: 'Bad',
        skills: {
          imports: [{}],
        },
      }),
    ).toThrow(/manifest\.skills\.imports entries require `source`/i);

    expect(sanitizeClawAgentId('  Main Agent!!!  ')).toBe('main-agent');
    expect(sanitizeClawAgentId('___', 'fallback-id')).toBe('fallback-id');

    expect(
      formatClawArchiveSummary({
        archivePath: '/tmp/demo.claw',
        manifest: {
          formatVersion: 1,
          name: 'Demo Agent',
          id: 'demo-agent',
          description: 'Portable package',
          author: 'Test Author',
          version: '1.2.3',
          agent: {
            model: {
              primary: 'gpt-5-mini',
            },
            enableRag: true,
          },
          skills: {
            bundled: ['alpha'],
            imports: [{ source: 'skills-sh/anthropics/skills/pdf' }],
            external: [{ kind: 'git', ref: 'https://example.com/alpha.git' }],
          },
          plugins: {
            bundled: ['demo-plugin'],
          },
        },
        totalCompressedBytes: 1024,
        totalUncompressedBytes: 2048,
        entryNames: ['manifest.json'],
      }),
    ).toEqual(
      expect.arrayContaining([
        'Name: Demo Agent',
        'Description: Portable package',
        'Author: Test Author',
        'Version: 1.2.3',
        'Suggested id: demo-agent',
        'Model: gpt-5-mini',
        'RAG: enabled',
        'Bundled skills: 1',
        'Skill imports: 1',
        'Bundled plugins: 1',
        'External refs: 1',
        'Skill dirs: alpha',
        'Skill import sources: skills-sh/anthropics/skills/pdf',
      ]),
    );
  });
});
