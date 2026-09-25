import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SkillInstallSpec } from '../src/skills/skills-install-spec.js';
import {
  normalizeInstallSpecs,
  parseInstallSpecList,
} from '../src/skills/skills-install-spec.js';

const mocks = vi.hoisted(() => ({
  hasBinary: vi.fn(),
  loadSkillCatalog: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock('../src/skills/skills.js', () => mocks);
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import {
  installSkillDependency,
  resolveSkillInstallSelection,
  setupSkillDependencies,
} from '../src/skills/skills-install.js';

const recipes: SkillInstallSpec[] = [
  {
    id: 'tool',
    kind: 'brew',
    os: ['darwin'],
    formula: 'example',
    bins: ['example'],
  },
  {
    id: 'tool',
    kind: 'go',
    os: ['linux'],
    module: 'example.com/tool@v1.0.0',
    bins: ['example'],
  },
];

function catalog(specs = recipes) {
  mocks.loadSkillCatalog.mockReturnValue([
    { name: 'demo', metadata: { hybridclaw: { install: specs } } },
  ]);
}

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  vi.spyOn(process, 'arch', 'get').mockReturnValue('x64');
  mocks.hasBinary.mockImplementation((bin: string) =>
    ['go', 'brew', 'npm'].includes(bin),
  );
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    queueMicrotask(() => child.emit('close', 0));
    return child;
  });
  catalog();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe('platform-aware dependency recipes', () => {
  test.each([
    ['linux', 'go'],
    ['darwin', 'brew'],
  ] as const)('%s selects %s for the same dependency id', (platform, kind) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    expect(
      resolveSkillInstallSelection({ skillName: 'demo', installId: 'tool' }),
    ).toMatchObject({ spec: { kind } });
  });

  test('uses the first available compatible alternative', () => {
    catalog([{ ...recipes[0], os: ['linux'] }, recipes[1]]);
    mocks.hasBinary.mockImplementation((bin: string) => bin === 'go');
    expect(
      resolveSkillInstallSelection({ skillName: 'demo', installId: 'tool' }),
    ).toMatchObject({ spec: { kind: 'go' } });
  });

  test('rejects unsupported OS and architecture before spawning', async () => {
    catalog([{ ...recipes[1], arch: ['arm64'] }]);
    expect(
      await installSkillDependency({ skillName: 'demo', installId: 'tool' }),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining('linux/x64'),
    });
    catalog([recipes[0]]);
    expect(
      await installSkillDependency({ skillName: 'demo', installId: 'tool' }),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining('No compatible installer'),
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  test('reports missing Go rather than trying brew on Linux', async () => {
    mocks.hasBinary.mockImplementation((bin: string) => bin === 'brew');
    expect(
      await installSkillDependency({ skillName: 'demo', installId: 'tool' }),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining('prerequisite (go)'),
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  test('skips an already installed dependency without an installer', async () => {
    mocks.hasBinary.mockImplementation((bin: string) => bin === 'example');
    expect(
      await installSkillDependency({ skillName: 'demo', installId: 'tool' }),
    ).toMatchObject({
      ok: true,
      message: expect.stringContaining('Already installed'),
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  test.each(['linux', 'darwin'] as const)(
    'setup on %s runs each dependency once',
    async (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
      catalog([...recipes, { id: 'second', kind: 'npm', package: 'second' }]);
      mocks.hasBinary.mockImplementation(
        (bin: string) =>
          ['go', 'brew', 'npm'].includes(bin) ||
          (bin === 'example' && mocks.spawn.mock.calls.length > 0),
      );
      const result = await setupSkillDependencies({ skillName: 'demo' });
      expect(result.ok).toBe(true);
      expect(mocks.spawn.mock.calls.map((call) => call.slice(0, 2))).toEqual([
        platform === 'linux'
          ? ['go', ['install', 'example.com/tool@v1.0.0']]
          : ['brew', ['install', 'example']],
        ['npm', ['install', '-g', '--ignore-scripts', 'second']],
      ]);
    },
  );

  test('does not try another recipe after execution failure', async () => {
    catalog([
      { ...recipes[1], module: 'example.com/first@v1.0.0' },
      recipes[1],
    ]);
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      queueMicrotask(() => child.emit('close', 1));
      return child;
    });
    expect((await setupSkillDependencies({ skillName: 'demo' })).ok).toBe(
      false,
    );
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  test('unrestricted recipes still work and empty bins do not skip installation', async () => {
    catalog([{ id: 'tool', kind: 'npm', package: 'example' }]);
    expect(
      (await installSkillDependency({ skillName: 'demo', installId: 'tool' }))
        .ok,
    ).toBe(true);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  test('reports binaries missing from PATH after installation', async () => {
    expect(
      await installSkillDependency({ skillName: 'demo', installId: 'tool' }),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining(
        'expected binaries are still missing: example',
      ),
    });
  });

  test.each([null, 'linux', [], ['linux', 42]])(
    'malformed platform restriction %j fails closed',
    async (os) => {
      const specs = normalizeInstallSpecs([{ ...recipes[1], os }], () => [
        'example',
      ]);
      expect(specs[0].os).toEqual([]);
      catalog(specs);
      expect(
        (await installSkillDependency({ skillName: 'demo', installId: 'tool' }))
          .ok,
      ).toBe(false);
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  test('reads block YAML constraints without losing alternatives', () => {
    const raw = parseInstallSpecList(`
      - id: tool
        kind: brew
        os: [darwin]
      - id: tool
        kind: go
        os:
          - linux
        arch: [arm64, x64]
    `);
    expect(normalizeInstallSpecs(raw, () => [])).toMatchObject([
      { id: 'tool', os: ['darwin'] },
      { id: 'tool', os: ['linux'], arch: ['arm64', 'x64'] },
    ]);
  });

  test('macOS uses the discovered Homebrew executable outside PATH', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    mocks.hasBinary.mockImplementation(
      (bin: string) =>
        bin === '/opt/homebrew/bin/brew' ||
        (bin === 'example' && mocks.spawn.mock.calls.length > 0),
    );
    expect(
      (await installSkillDependency({ skillName: 'demo', installId: 'tool' }))
        .ok,
    ).toBe(true);
    expect(mocks.spawn).toHaveBeenCalledWith(
      '/opt/homebrew/bin/brew',
      ['install', 'example'],
      expect.any(Object),
    );
  });

  test('rejects invalid command arguments even when binaries already exist', async () => {
    catalog([{ ...recipes[1], module: '-unsafe' }]);
    mocks.hasBinary.mockReturnValue(true);
    expect(
      await installSkillDependency({ skillName: 'demo', installId: 'tool' }),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining('Invalid install spec'),
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  test('preserves os/arch arrays during normalization', () => {
    expect(
      normalizeInstallSpecs([{ ...recipes[1], arch: ['arm64'] }], () => [
        'example',
      ]),
    ).toMatchObject([{ os: ['linux'], arch: ['arm64'] }]);
  });
});
