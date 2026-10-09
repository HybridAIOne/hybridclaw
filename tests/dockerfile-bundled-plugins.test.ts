import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

// The gateway image ships a plugin only when `.dockerignore` lets it into the
// build context and the runtime stage copies it. A bare-id `plugin install`
// that finds no bundled copy falls through to the npm registry, so a plugin
// core's console and docs send operators to must be in the image.
const repoRoot = path.resolve(import.meta.dirname, '..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');
}

function contextPlugins(): string[] {
  return [
    ...readRepoFile('.dockerignore').matchAll(/^!plugins\/([^/*]+)\/$/gm),
  ]
    .map((match) => match[1])
    .sort();
}

function runtimeStagePlugins(): string[] {
  const dockerfile = readRepoFile('Dockerfile');
  const runtime = dockerfile.slice(dockerfile.indexOf(' AS runtime'));
  return [
    ...runtime.matchAll(
      /^COPY --link --from=builder \/app\/plugins\/([^ ]+) \.\/plugins\/\1$/gm,
    ),
  ]
    .map((match) => match[1])
    .sort();
}

test('the runtime stage copies exactly the plugins the build context admits', () => {
  expect(runtimeStagePlugins()).toEqual(contextPlugins());
});

test('the image ships the distill plugin the admin console tells operators to install', () => {
  expect(runtimeStagePlugins()).toContain('distill');
  expect(
    fs.existsSync(
      path.join(repoRoot, 'plugins', 'distill', 'hybridclaw.plugin.yaml'),
    ),
  ).toBe(true);
});

// An upgraded v0.39 config that selected a vendor browser provider enables the
// bundled plugin of that id, so the image must carry every one of them.
test('the image ships every bundled browser provider plugin', () => {
  const browserProviderPlugins = fs
    .readdirSync(path.join(repoRoot, 'plugins'))
    .filter((id) => {
      const entry = path.join(repoRoot, 'plugins', id, 'src', 'index.js');
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
  expect(runtimeStagePlugins()).toEqual(
    expect.arrayContaining(browserProviderPlugins),
  );
});
