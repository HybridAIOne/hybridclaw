import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  isExcludedPackage,
  shouldCopyEntry,
  shouldIncludePackage,
  stageInstalledNodeModules,
} from './prepare-runtime.mjs';

describe('prepare-runtime package filtering', () => {
  test('excludes type-only packages from the runtime bundle', () => {
    expect(
      isExcludedPackage(path.join('/repo', 'node_modules', '@types', 'node')),
    ).toBe(true);
  });

  test('evaluates package os and cpu constraints against the build target', async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'hc-runtime-pkg-'),
    );
    const packagePath = path.join(tempRoot, 'native-package');
    await fs.mkdir(packagePath);
    await fs.writeFile(
      path.join(packagePath, 'package.json'),
      JSON.stringify({ os: ['darwin'], cpu: ['x64'] }),
    );

    try {
      await expect(
        shouldIncludePackage(packagePath, { platform: 'darwin', arch: 'x64' }),
      ).resolves.toBe(true);
      await expect(
        shouldIncludePackage(packagePath, {
          platform: 'darwin',
          arch: 'arm64',
        }),
      ).resolves.toBe(false);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('strips package-level fixtures without stripping nested runtime data', () => {
    const packagePath = path.join('/repo', 'node_modules', 'example-package');

    expect(shouldCopyEntry(path.join(packagePath, 'tests'), packagePath)).toBe(
      false,
    );
    expect(
      shouldCopyEntry(path.join(packagePath, 'dist', 'tests'), packagePath),
    ).toBe(true);
  });

  test('strips non-runtime metadata files from copied packages', () => {
    const packagePath = path.join('/repo', 'node_modules', 'example-package');

    expect(
      shouldCopyEntry(
        path.join(packagePath, 'dist', 'index.d.ts'),
        packagePath,
      ),
    ).toBe(false);
    expect(
      shouldCopyEntry(
        path.join(packagePath, 'dist', 'index.js.map'),
        packagePath,
      ),
    ).toBe(false);
    expect(
      shouldCopyEntry(path.join(packagePath, 'dist', 'index.js'), packagePath),
    ).toBe(true);
  });

  test('stages symlinked file: dependencies as real package directories', async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'hc-runtime-stage-'),
    );
    const source = path.join(tempRoot, 'tools', 'node_modules');
    const target = path.join(tempRoot, 'staged');
    const stub = path.join(tempRoot, 'tools', 'stubs', 'image-size');
    try {
      await fs.mkdir(path.join(source, 'docx'), { recursive: true });
      await fs.writeFile(path.join(source, 'docx', 'package.json'), '{}');
      await fs.mkdir(stub, { recursive: true });
      await fs.writeFile(
        path.join(stub, 'package.json'),
        '{"name":"image-size"}',
      );
      await fs.symlink(
        path.join('..', 'stubs', 'image-size'),
        path.join(source, 'image-size'),
      );

      await stageInstalledNodeModules(source, target);

      expect(
        (await fs.lstat(path.join(target, 'image-size'))).isDirectory(),
      ).toBe(true);
      expect(
        await fs.readFile(
          path.join(target, 'image-size', 'package.json'),
          'utf8',
        ),
      ).toBe('{"name":"image-size"}');
      expect((await fs.readdir(target)).sort()).toEqual(['docx', 'image-size']);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
