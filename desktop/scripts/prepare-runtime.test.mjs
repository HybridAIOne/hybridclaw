import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  isExcludedPackage,
  shouldCopyEntry,
  shouldIncludePackage,
} from './prepare-runtime.mjs';

const target = { platform: 'darwin', arch: 'arm64' };

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

  test('keeps only the target onnxruntime-node native binaries', () => {
    const packagePath = path.join('/repo', 'node_modules', 'onnxruntime-node');

    expect(
      shouldCopyEntry(
        path.join(
          packagePath,
          'bin',
          'napi-v3',
          'darwin',
          'arm64',
          'onnxruntime_binding.node',
        ),
        packagePath,
        target,
      ),
    ).toBe(true);
    expect(
      shouldCopyEntry(
        path.join(
          packagePath,
          'bin',
          'napi-v3',
          'darwin',
          'x64',
          'onnxruntime_binding.node',
        ),
        packagePath,
        target,
      ),
    ).toBe(false);
    expect(
      shouldCopyEntry(
        path.join(
          packagePath,
          'bin',
          'napi-v3',
          'linux',
          'arm64',
          'onnxruntime_binding.node',
        ),
        packagePath,
        target,
      ),
    ).toBe(false);
  });
});
