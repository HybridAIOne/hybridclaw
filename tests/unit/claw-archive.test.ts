import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
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

function writePluginDir(dir: string, pluginId: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hybridclaw.plugin.yaml'),
    [
      `id: ${pluginId}`,
      'name: Demo Plugin',
      'version: 1.0.0',
      'kind: tool',
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

afterEach(async () => {
  process.chdir(originalCwd);
  vi.resetModules();
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('.claw archive support', () => {
  test('packs, inspects, and unpacks an agent round-trip', async () => {
    const homeDir = makeTempDir('hybridclaw-claw-home-');
    const cwd = makeTempDir('hybridclaw-claw-cwd-');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    process.chdir(cwd);

    const { initDatabase } = await import('../../src/memory/db.js');
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
          model: 'gpt-5-mini',
          enableRag: false,
        },
      ],
    });

    ensureBootstrapFiles('main');
    const sourceWorkspace = agentWorkspaceDir('main');
    fs.mkdirSync(path.join(sourceWorkspace, 'notes'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceWorkspace, 'notes', 'bio.md'),
      'portable memory\n',
      'utf-8',
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
    writePluginDir(pluginDir, 'demo-plugin');

    updateRuntimeConfig((draft) => {
      draft.agents.list = [
        {
          id: 'main',
          name: 'Main Agent',
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
    expect(
      fs.readFileSync(
        path.join(unpacked.workspacePath, 'notes', 'bio.md'),
        'utf-8',
      ),
    ).toBe('portable memory\n');
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

  test('manifest validation rejects unknown format versions', async () => {
    const { validateClawManifest } = await import(
      '../../src/agents/claw-manifest.js'
    );
    expect(() =>
      validateClawManifest({
        formatVersion: 2,
        name: 'Bad',
      }),
    ).toThrow(/Unsupported \.claw formatVersion/i);
  });
});
