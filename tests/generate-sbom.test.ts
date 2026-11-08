import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { useTempDir } from './test-utils.js';

const run = promisify(execFile);
const makeTempDir = useTempDir();

test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  'generates SBOMs and cleans staging (workspace: %s, invalid: %s)',
  async (workspace, invalid) => {
    const root = makeTempDir('hybridclaw-sbom-overrides-');
    const dependency = { 'example-parent': '1.0.0' };
    const manifest = {
      name: 'example-app',
      version: '1.0.0',
      packageManager: JSON.parse(fs.readFileSync('package.json', 'utf8'))
        .packageManager,
      dependencies: { 'example-runtime': '1.0.0' },
      ...(workspace
        ? { workspaces: ['desktop'] }
        : { devDependencies: dependency }),
      overrides: { 'example-leaf': '2.0.0' },
    };
    const workspaceManifest = {
      name: 'example-desktop',
      version: '1.0.0',
      devDependencies: dependency,
    };
    const packages = {
      '': manifest,
      ...(workspace
        ? {
            desktop: workspaceManifest,
            'node_modules/example-desktop': { resolved: 'desktop', link: true },
          }
        : {}),
      'node_modules/example-parent': {
        version: '1.0.0',
        resolved:
          'https://registry.npmjs.org/example-parent/-/example-parent-1.0.0.tgz',
        dev: true,
        dependencies: { 'example-leaf': '^1.0.0' },
      },
      'node_modules/example-leaf': {
        version: '2.0.0',
        resolved:
          'https://registry.npmjs.org/example-leaf/-/example-leaf-2.0.0.tgz',
        dev: true,
      },
      'node_modules/example-runtime': {
        version: invalid ? '2.0.0' : '1.0.0',
        resolved:
          'https://registry.npmjs.org/example-runtime/-/example-runtime-1.0.0.tgz',
      },
    };
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
    fs.writeFileSync(
      path.join(root, 'package-lock.json'),
      JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        lockfileVersion: 3,
        packages,
      }),
    );
    if (workspace) {
      fs.mkdirSync(path.join(root, 'desktop'));
      fs.writeFileSync(
        path.join(root, 'desktop', 'package.json'),
        JSON.stringify(workspaceManifest),
      );
    }

    const tmpDir = path.join(root, 'tmp');
    fs.mkdirSync(tmpDir);
    const result = run(
      process.execPath,
      [path.resolve('scripts/generate-sbom.mjs')],
      {
        cwd: root,
        env: {
          ...process.env,
          NPM_CONFIG_OFFLINE: 'true',
          NODE_DISABLE_COMPILE_CACHE: '1',
          TMPDIR: tmpDir,
        },
      },
    );
    if (invalid) {
      await expect(result).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('ESBOMPROBLEMS'),
      });
      expect(fs.readdirSync(tmpDir)).toEqual([]);
      return;
    }
    await result;
    expect(fs.readdirSync(tmpDir)).toEqual([]);

    const cdx = JSON.parse(
      fs.readFileSync(path.join(root, 'sbom', 'example-app.cdx.json'), 'utf8'),
    );
    expect(cdx.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'example-runtime', version: '1.0.0' }),
      ]),
    );
    expect(
      cdx.components.map((component: { name: string }) => component.name),
    ).not.toContain('example-leaf');
    const spdx = JSON.parse(
      fs.readFileSync(path.join(root, 'sbom', 'example-app.spdx.json'), 'utf8'),
    );
    expect(spdx.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'example-runtime',
          versionInfo: '1.0.0',
        }),
      ]),
    );
    expect(
      spdx.packages.map((component: { name: string }) => component.name),
    ).not.toContain('example-leaf');
  },
);
