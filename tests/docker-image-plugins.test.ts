import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

// The gateway image ships the plugins `.dockerignore` admits, copied by one
// `COPY plugins/` line. `isPackagedPluginId` reads package.json `files`, so a
// packaged plugin missing from the image makes `plugin install <id>` fail
// there; the two lists must stay equal.
const ROOT = path.resolve(import.meta.dirname, '..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');
}

function packagedPlugins(): string[] {
  const files: string[] = JSON.parse(readRepoFile('package.json')).files;
  return files
    .map((entry) => /^plugins\/([^/*]+)\/?$/.exec(entry)?.[1])
    .filter((id): id is string => Boolean(id))
    .sort();
}

function imagePlugins(): string[] {
  const ignore = readRepoFile('.dockerignore').split('\n');
  expect(ignore).toContain('plugins/*');
  const admitted = ignore
    .map((line) => /^!plugins\/([^/*]+)\/$/.exec(line.trim())?.[1])
    .filter((id): id is string => Boolean(id));
  for (const id of admitted) expect(ignore).toContain(`!plugins/${id}/**`);
  return admitted.sort();
}

test('the image ships exactly the plugins the npm package ships', () => {
  expect(imagePlugins()).toEqual(packagedPlugins());
});

test('the runtime stage copies plugins/ in one step', () => {
  const dockerfile = readRepoFile('Dockerfile');
  const runtime = dockerfile.slice(dockerfile.indexOf(' AS runtime'));
  expect(runtime.match(/^COPY .*plugins\/.*$/gm)).toEqual([
    'COPY --link plugins/ ./plugins/',
  ]);
});

// tier-router is enabled by routing.enabled, twilio-voice by the v0.39 voice
// migration and distill by the admin console's install hint, all without an
// npm download, so the package (and with it the image) must carry them.
test.each([
  'distill',
  'tier-router',
  'twilio-voice',
])('the package ships plugins/%s', (pluginId) => {
  expect(packagedPlugins()).toContain(pluginId);
});

// An upgraded v0.39 config that selected a vendor browser provider enables the
// bundled plugin of that id, so the package must carry every one of them.
test('the package ships every browser provider plugin', () => {
  const browserProviderPlugins = fs
    .readdirSync(path.join(ROOT, 'plugins'))
    .filter((id) => {
      const entry = path.join(ROOT, 'plugins', id, 'src', 'index.js');
      return (
        fs.existsSync(entry) &&
        fs.readFileSync(entry, 'utf-8').includes('registerBrowserProvider(')
      );
    })
    .sort();

  expect(browserProviderPlugins).toEqual([
    'browser-use-cloud',
    'camofox',
    'mac-cua',
    'managed-cloud',
  ]);
  expect(packagedPlugins()).toEqual(
    expect.arrayContaining(browserProviderPlugins),
  );
});
