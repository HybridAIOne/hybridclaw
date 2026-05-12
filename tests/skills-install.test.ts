import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

function createMockSpawnProcess(params?: {
  code?: number | null;
  stdout?: string;
  stderr?: string;
}): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();

  queueMicrotask(() => {
    if (params?.stdout) {
      child.stdout.emit('data', Buffer.from(params.stdout));
    }
    if (params?.stderr) {
      child.stderr.emit('data', Buffer.from(params.stderr));
    }
    child.emit('close', params?.code ?? 0);
  });

  return child;
}

describe('skill install metadata', () => {
  const originalHome = process.env.HOME;
  const originalDisableWatcher = process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
  const tempHomes: string[] = [];

  beforeEach(() => {
    const tempHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-skills-install-'),
    );
    tempHomes.push(tempHome);
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('../src/logger.js');
    vi.doUnmock('../src/skills/skills-guard.ts');
    vi.doUnmock('../src/skills/skills.ts');
    vi.doUnmock('node:child_process');
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

  test('loads install metadata declared by the 1password skill', async () => {
    const { findSkillCatalogEntry } = await import(
      '../src/skills/skills-install.ts'
    );
    const skill = findSkillCatalogEntry('1password');
    expect(skill).not.toBeNull();
    expect(skill?.metadata.hybridclaw.install).toEqual([
      {
        id: 'op',
        kind: 'brew',
        formula: '1password-cli',
        bins: ['op'],
        label: 'Install 1Password CLI (brew)',
      },
    ]);
  });

  test('resolves a declared install option by id', async () => {
    const { resolveSkillInstallSelection } = await import(
      '../src/skills/skills-install.ts'
    );
    const selection = resolveSkillInstallSelection({
      skillName: '1password',
      installId: 'op',
    });

    if ('error' in selection) {
      throw new Error(selection.error);
    }

    expect(selection.installId).toBe('op');
    expect(selection.spec.kind).toBe('brew');
    expect(selection.spec.formula).toBe('1password-cli');
  });

  test('reads install metadata and requires from metadata.openclaw', async () => {
    const { DEFAULT_RUNTIME_HOME_DIR } = await import(
      '../src/config/runtime-paths.ts'
    );
    const { findSkillCatalogEntry } = await import(
      '../src/skills/skills-install.ts'
    );

    const skillDir = path.join(DEFAULT_RUNTIME_HOME_DIR, 'skills', 'openhue');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: openhue',
        'description: Control Philips Hue lights and scenes.',
        'metadata: {"openclaw":{"requires":{"bins":["openhue"]},"install":[{"id":"openhue","kind":"brew","formula":"openhue/cli/openhue-cli","bins":["openhue"],"label":"Install OpenHue CLI (brew)"}]}}',
        '---',
        '',
        '# OpenHue',
      ].join('\n'),
      'utf8',
    );

    const skill = findSkillCatalogEntry('openhue');

    expect(skill).not.toBeNull();
    expect(skill?.requires).toEqual({
      bins: ['openhue'],
      env: [],
    });
    // openclaw input is normalized into the hybridclaw-shaped output metadata.
    expect(skill?.metadata.hybridclaw.install).toEqual([
      {
        id: 'openhue',
        kind: 'brew',
        formula: 'openhue/cli/openhue-cli',
        bins: ['openhue'],
        label: 'Install OpenHue CLI (brew)',
      },
    ]);
  });

  test('prefers metadata.hybridclaw over metadata.openclaw when both exist', async () => {
    const { DEFAULT_RUNTIME_HOME_DIR } = await import(
      '../src/config/runtime-paths.ts'
    );
    const { findSkillCatalogEntry } = await import(
      '../src/skills/skills-install.ts'
    );

    const skillDir = path.join(
      DEFAULT_RUNTIME_HOME_DIR,
      'skills',
      'openhue-dedupe',
    );
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: openhue-dedupe',
        'description: Prefer hybridclaw metadata over openclaw metadata.',
        'metadata: {"hybridclaw":{"requires":{"bins":["openhue"]},"install":[{"id":"openhue","kind":"brew","formula":"openhue/cli/openhue-cli","bins":["openhue"],"label":"Install OpenHue CLI (brew)"}]},"openclaw":{"requires":{"bins":["ignored-openclaw-bin"]},"install":[{"id":"ignored-openclaw-package","kind":"npm","package":"ignored-openclaw-package","label":"Ignored OpenClaw install"}]}}',
        '---',
        '',
        '# OpenHue Dedupe',
      ].join('\n'),
      'utf8',
    );

    const skill = findSkillCatalogEntry('openhue-dedupe');

    expect(skill).not.toBeNull();
    expect(skill?.requires).toEqual({
      bins: ['openhue'],
      env: [],
    });
    expect(skill?.metadata.hybridclaw.install).toEqual([
      {
        id: 'openhue',
        kind: 'brew',
        formula: 'openhue/cli/openhue-cli',
        bins: ['openhue'],
        label: 'Install OpenHue CLI (brew)',
      },
    ]);
  });

  test('warns when an explicit requires declaration is malformed', async () => {
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    vi.doMock('../src/logger.js', () => ({ logger }));

    const { DEFAULT_RUNTIME_HOME_DIR } = await import(
      '../src/config/runtime-paths.ts'
    );
    const { findSkillCatalogEntry } = await import(
      '../src/skills/skills-install.ts'
    );

    const skillDir = path.join(
      DEFAULT_RUNTIME_HOME_DIR,
      'skills',
      'malformed-requires',
    );
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: malformed-requires',
        'description: Has an invalid requires declaration.',
        'requires:',
        '  unexpected: true',
        '---',
        '',
        '# Malformed Requires',
      ].join('\n'),
      'utf8',
    );

    const skill = findSkillCatalogEntry('malformed-requires');

    expect(skill).not.toBeNull();
    expect(skill?.requires).toEqual({
      bins: [],
      env: [],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      {
        path: path.join(skillDir, 'SKILL.md'),
        source: 'requires',
      },
      'Ignoring malformed skill requires declaration',
    );
  });

  test('rejects download installers that do not use https', async () => {
    vi.doMock('../src/skills/skills-guard.ts', async () => {
      const actual = await vi.importActual<
        typeof import('../src/skills/skills-guard.ts')
      >('../src/skills/skills-guard.ts');
      return {
        ...actual,
        guardSkillDirectory: () => ({ allowed: true }),
      };
    });

    const { installSkillDependency } = await import(
      '../src/skills/skills-install.ts'
    );

    const skillDir = path.join(
      process.env.HOME || '',
      '.codex',
      'skills',
      'download-http',
    );
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: download-http',
        'description: Reject insecure download urls.',
        'metadata: {"hybridclaw":{"install":[{"id":"download-tool","kind":"download","url":"http://169.254.169.254/latest/meta-data/","path":"tools/example.bin","label":"Download example"}]}}',
        '---',
        '',
        '# Download Http',
      ].join('\n'),
      'utf8',
    );

    const result = await installSkillDependency({
      skillName: 'download-http',
      installId: 'download-tool',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('download url must use https');
  });

  test('rejects download installers that escape the safe downloads directory', async () => {
    vi.doMock('../src/skills/skills-guard.ts', async () => {
      const actual = await vi.importActual<
        typeof import('../src/skills/skills-guard.ts')
      >('../src/skills/skills-guard.ts');
      return {
        ...actual,
        guardSkillDirectory: () => ({ allowed: true }),
      };
    });

    const { installSkillDependency } = await import(
      '../src/skills/skills-install.ts'
    );

    const skillDir = path.join(
      process.env.HOME || '',
      '.codex',
      'skills',
      'download-traversal',
    );
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: download-traversal',
        'description: Reject escaping download paths.',
        'metadata: {"hybridclaw":{"install":[{"id":"download-tool","kind":"download","url":"https://example.com/tool.bin","path":"../../.ssh/authorized_keys","label":"Download example"}]}}',
        '---',
        '',
        '# Download Traversal',
      ].join('\n'),
      'utf8',
    );

    const result = await installSkillDependency({
      skillName: 'download-traversal',
      installId: 'download-tool',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain(
      'download path must be inside ~/.hybridclaw/downloads',
    );
  });

  test('requires the explicit skill name and dependency id', async () => {
    vi.doMock('../src/skills/skills-guard.ts', async () => {
      const actual = await vi.importActual<
        typeof import('../src/skills/skills-guard.ts')
      >('../src/skills/skills-guard.ts');
      return {
        ...actual,
        guardSkillDirectory: () => ({ allowed: true }),
      };
    });

    const { resolveSkillInstallSelection } = await import(
      '../src/skills/skills-install.ts'
    );

    const skillDir = path.join(
      process.env.HOME || '',
      '.codex',
      'skills',
      'manim-shortcut',
    );
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: manim-shortcut',
        'description: Test explicit install command requirement.',
        'metadata: {"hybridclaw":{"install":[{"id":"manim","kind":"uv","package":"manim","label":"Install Manim (uv)"}]}}',
        '---',
        '',
        '# Manim Shortcut',
      ].join('\n'),
      'utf8',
    );

    const selection = resolveSkillInstallSelection({
      skillName: 'manim-shortcut',
    });

    expect(selection).toEqual({
      error: expect.stringContaining(
        'Missing dependency id for "manim-shortcut"',
      ),
    });
    if (!('error' in selection)) {
      throw new Error('Expected install selection failure');
    }
    expect(selection.error).toContain(
      'retry: skill install manim-shortcut manim',
    );
  });

  test('lists explicit retry commands when a skill has multiple install options', async () => {
    vi.doMock('../src/skills/skills-guard.ts', async () => {
      const actual = await vi.importActual<
        typeof import('../src/skills/skills-guard.ts')
      >('../src/skills/skills-guard.ts');
      return {
        ...actual,
        guardSkillDirectory: () => ({ allowed: true }),
      };
    });

    const { resolveSkillInstallSelection } = await import(
      '../src/skills/skills-install.ts'
    );

    const skillDir = path.join(
      process.env.HOME || '',
      '.codex',
      'skills',
      'manim-multi',
    );
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: manim-multi',
        'description: Test multiple install options.',
        'metadata: {"hybridclaw":{"install":[{"id":"manim","kind":"uv","package":"manim","label":"Install Manim (uv)"},{"id":"ffmpeg","kind":"brew","formula":"ffmpeg","label":"Install ffmpeg (brew)"}]}}',
        '---',
        '',
        '# Manim Multi',
      ].join('\n'),
      'utf8',
    );

    const selection = resolveSkillInstallSelection({
      skillName: 'manim-multi',
    });

    expect(selection).toEqual({
      error: expect.stringContaining('retry: skill install manim-multi manim'),
    });
    if (!('error' in selection)) {
      throw new Error('Expected install selection failure');
    }
    expect(selection.error).toContain(
      'retry: skill install manim-multi ffmpeg',
    );
  });

  test('bootstraps uv with brew before running a uv installer', async () => {
    const skillDir = path.join(
      process.env.HOME || '',
      '.codex',
      'skills',
      'manim-uv',
    );
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: manim-uv',
        'description: Test uv installer bootstrap.',
        'metadata: {"hybridclaw":{"install":[{"id":"manim","kind":"uv","package":"manim","label":"Install Manim (uv)"}]}}',
        '---',
        '',
        '# Manim Uv',
      ].join('\n'),
      'utf8',
    );

    const spawnMock = vi
      .fn()
      .mockImplementationOnce(() => createMockSpawnProcess({ code: 0 }))
      .mockImplementationOnce(() =>
        createMockSpawnProcess({ code: 0, stdout: '/opt/homebrew\n' }),
      )
      .mockImplementationOnce(() => createMockSpawnProcess({ code: 0 }));
    vi.doMock('node:child_process', () => ({
      spawn: spawnMock,
    }));
    vi.doMock('../src/skills/skills.ts', async () => {
      const actual = await vi.importActual<
        typeof import('../src/skills/skills.ts')
      >('../src/skills/skills.ts');
      return {
        ...actual,
        hasBinary: (binName: string) => binName === 'brew',
      };
    });

    const { installSkillDependency } = await import(
      '../src/skills/skills-install.ts'
    );
    const result = await installSkillDependency({
      skillName: 'manim-uv',
      installId: 'manim',
    });

    expect(result.ok).toBe(true);
    expect(result.message).toBe('Installed manim-uv via manim');
    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      'brew',
      ['install', 'uv'],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'brew',
      ['--prefix'],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      3,
      'uv',
      ['tool', 'install', 'manim'],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe'],
        env: expect.objectContaining({
          PATH: expect.stringContaining('/opt/homebrew/bin'),
        }),
      }),
    );
  });

  test('sets up every declared dependency for a skill', async () => {
    const spawnMock = vi
      .fn()
      .mockImplementationOnce(() =>
        createMockSpawnProcess({ code: 0, stdout: 'installed first\n' }),
      )
      .mockImplementationOnce(() =>
        createMockSpawnProcess({ code: 0, stdout: 'installed second\n' }),
      );
    vi.doMock('node:child_process', () => ({
      spawn: spawnMock,
    }));
    vi.doMock('../src/skills/skills.ts', async () => {
      const actual = await vi.importActual<
        typeof import('../src/skills/skills.ts')
      >('../src/skills/skills.ts');
      return {
        ...actual,
        hasBinary: () => true,
        loadSkillCatalog: () => [
          {
            name: 'setup-demo',
            description: 'Demo setup skill',
            category: 'test',
            userInvocable: true,
            disableModelInvocation: false,
            always: false,
            requires: { bins: [], env: [] },
            metadata: {
              hybridclaw: {
                tags: [],
                relatedSkills: [],
                install: [
                  {
                    id: 'first-tool',
                    kind: 'npm',
                    package: 'first-tool',
                    bins: ['first-tool'],
                  },
                  {
                    id: 'second-tool',
                    kind: 'npm',
                    package: 'second-tool',
                    bins: ['second-tool'],
                  },
                ],
              },
            },
            filePath: '/tmp/setup-demo/SKILL.md',
            baseDir: '/tmp/setup-demo',
            source: 'bundled',
            available: true,
            enabled: true,
            missing: [],
          },
        ],
      };
    });

    const { setupSkillDependencies } = await import(
      '../src/skills/skills-install.ts'
    );
    const result = await setupSkillDependencies({ skillName: 'setup-demo' });

    expect(result.ok).toBe(true);
    expect(result.message).toBe(
      'Set up setup-demo: installed first-tool, second-tool',
    );
    expect(result.stdout).toContain('[first-tool]\ninstalled first');
    expect(result.stdout).toContain('[second-tool]\ninstalled second');
    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      'npm',
      ['install', '-g', '--ignore-scripts', 'first-tool'],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'npm',
      ['install', '-g', '--ignore-scripts', 'second-tool'],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  });
});
