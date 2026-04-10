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

  test('loads install metadata declared by the pdf skill', async () => {
    const { findSkillCatalogEntry } = await import(
      '../src/skills/skills-install.ts'
    );
    const skill = findSkillCatalogEntry('pdf');
    expect(skill).not.toBeNull();
    expect(skill?.metadata.hybridclaw.install).toEqual([
      {
        id: 'brew-poppler',
        kind: 'brew',
        formula: 'poppler',
        bins: ['pdftotext', 'pdftoppm', 'pdfinfo', 'pdfimages'],
        label: 'Install Poppler CLI tools (brew)',
      },
      {
        id: 'brew-qpdf',
        kind: 'brew',
        formula: 'qpdf',
        bins: ['qpdf'],
        label: 'Install qpdf (brew)',
      },
    ]);
  });

  test('resolves a declared install option by id', async () => {
    const { resolveSkillInstallSelection } = await import(
      '../src/skills/skills-install.ts'
    );
    const selection = resolveSkillInstallSelection({
      skillName: 'pdf',
      installId: 'brew-poppler',
    });

    if ('error' in selection) {
      throw new Error(selection.error);
    }

    expect(selection.installId).toBe('brew-poppler');
    expect(selection.spec.kind).toBe('brew');
    expect(selection.spec.formula).toBe('poppler');
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
        'metadata: {"openclaw":{"requires":{"bins":["openhue"]},"install":[{"id":"brew","kind":"brew","formula":"openhue/cli/openhue-cli","bins":["openhue"],"label":"Install OpenHue CLI (brew)"}]}}',
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
        id: 'brew',
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
        'metadata: {"hybridclaw":{"requires":{"bins":["openhue"]},"install":[{"id":"brew","kind":"brew","formula":"openhue/cli/openhue-cli","bins":["openhue"],"label":"Install OpenHue CLI (brew)"}]},"openclaw":{"requires":{"bins":["ignored-openclaw-bin"]},"install":[{"id":"npm","kind":"npm","package":"ignored-openclaw-package","label":"Ignored OpenClaw install"}]}}',
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
        id: 'brew',
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

  test('loads pip install metadata declared by a skill', async () => {
    vi.doMock('../src/skills/skills-guard.ts', async () => {
      const actual = await vi.importActual<
        typeof import('../src/skills/skills-guard.ts')
      >('../src/skills/skills-guard.ts');
      return {
        ...actual,
        guardSkillDirectory: () => ({ allowed: true }),
      };
    });

    const { findSkillCatalogEntry } = await import(
      '../src/skills/skills-install.ts'
    );

    const skillDir = path.join(
      process.env.HOME || '',
      '.codex',
      'skills',
      'manim-test',
    );
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: manim-test',
        'description: Test pip install parsing.',
        'metadata: {"hybridclaw":{"install":[{"id":"pip-manim","kind":"pip","package":"manim==0.19.0","label":"Install Manim (pip)"}]}}',
        '---',
        '',
        '# Manim Test',
      ].join('\n'),
      'utf8',
    );

    const skill = findSkillCatalogEntry('manim-test');

    expect(skill).not.toBeNull();
    expect(skill?.metadata.hybridclaw.install).toEqual([
      {
        id: 'pip-manim',
        kind: 'pip',
        package: 'manim==0.19.0',
        label: 'Install Manim (pip)',
        bins: [],
      },
    ]);
  });

  test('loads top-level install metadata declared by a skill', async () => {
    vi.doMock('../src/skills/skills-guard.ts', async () => {
      const actual = await vi.importActual<
        typeof import('../src/skills/skills-guard.ts')
      >('../src/skills/skills-guard.ts');
      return {
        ...actual,
        guardSkillDirectory: () => ({ allowed: true }),
      };
    });

    const { findSkillCatalogEntry } = await import(
      '../src/skills/skills-install.ts'
    );

    const skillDir = path.join(
      process.env.HOME || '',
      '.codex',
      'skills',
      'manim-top-level',
    );
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: manim-top-level',
        'description: Test top-level install parsing.',
        'install:',
        '  - id: pip-manim',
        '    kind: pip',
        '    package: manim==0.19.0',
        '    label: Install Manim (pip)',
        '---',
        '',
        '# Manim Top Level',
      ].join('\n'),
      'utf8',
    );

    const skill = findSkillCatalogEntry('manim-top-level');

    expect(skill).not.toBeNull();
    expect(skill?.metadata.hybridclaw.install).toEqual([
      {
        id: 'pip-manim',
        kind: 'pip',
        package: 'manim==0.19.0',
        label: 'Install Manim (pip)',
        bins: [],
      },
    ]);
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
        'metadata: {"hybridclaw":{"install":[{"id":"uv-manim-shortcut","kind":"uv","package":"manim","label":"Install Manim (uv)"}]}}',
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
      'retry: skill install manim-shortcut uv-manim-shortcut',
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
        'metadata: {"hybridclaw":{"install":[{"id":"uv-manim","kind":"uv","package":"manim","label":"Install Manim (uv)"},{"id":"brew-ffmpeg","kind":"brew","formula":"ffmpeg","label":"Install ffmpeg (brew)"}]}}',
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
      error: expect.stringContaining(
        'retry: skill install manim-multi uv-manim',
      ),
    });
    if (!('error' in selection)) {
      throw new Error('Expected install selection failure');
    }
    expect(selection.error).toContain(
      'retry: skill install manim-multi brew-ffmpeg',
    );
  });

  test('installs pip packages via python -m pip', async () => {
    const skillDir = path.join(
      process.env.HOME || '',
      '.codex',
      'skills',
      'manim-pip',
    );
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: manim-pip',
        'description: Test pip installer execution.',
        'metadata: {"hybridclaw":{"install":[{"id":"pip-manim","kind":"pip","package":"manim==0.19.0","label":"Install Manim (pip)"}]}}',
        '---',
        '',
        '# Manim Pip',
      ].join('\n'),
      'utf8',
    );

    const spawnMock = vi.fn(() => createMockSpawnProcess({ code: 0 }));
    vi.doMock('node:child_process', () => ({
      spawn: spawnMock,
    }));
    vi.doMock('../src/skills/skills.ts', async () => {
      const actual = await vi.importActual<
        typeof import('../src/skills/skills.ts')
      >('../src/skills/skills.ts');
      return {
        ...actual,
        hasBinary: (binName: string) => binName === 'python3',
      };
    });

    const { installSkillDependency } = await import(
      '../src/skills/skills-install.ts'
    );
    const result = await installSkillDependency({
      skillName: 'manim-pip',
      installId: 'pip-manim',
    });

    expect(result.ok).toBe(true);
    expect(result.message).toBe('Installed manim-pip via pip-manim');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      'python3',
      ['-m', 'pip', 'install', 'manim==0.19.0'],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
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
        'metadata: {"hybridclaw":{"install":[{"id":"uv-manim","kind":"uv","package":"manim","label":"Install Manim (uv)"}]}}',
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
      installId: 'uv-manim',
    });

    expect(result.ok).toBe(true);
    expect(result.message).toBe('Installed manim-uv via uv-manim');
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
});
