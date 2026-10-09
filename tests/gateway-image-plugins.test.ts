import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

// An upgraded v0.39 config that selected a vendor browser provider enables
// the bundled plugin of that id, so the gateway image must carry its source.
const BROWSER_PROVIDER_PLUGINS = fs
  .readdirSync(path.join(ROOT, 'plugins'))
  .filter((id) => {
    const entry = path.join(ROOT, 'plugins', id, 'src', 'index.js');
    return (
      fs.existsSync(entry) &&
      fs.readFileSync(entry, 'utf8').includes('registerBrowserProvider(')
    );
  })
  .sort();

test('the bundled browser provider plugins are found', () => {
  expect(BROWSER_PROVIDER_PLUGINS).toEqual([
    'browser-use-cloud',
    'camofox',
    'mac-cua',
    'managed-cloud',
  ]);
});

test.each(BROWSER_PROVIDER_PLUGINS)('the gateway image ships the %s plugin', (id) => {
  const dockerignore = fs
    .readFileSync(path.join(ROOT, '.dockerignore'), 'utf8')
    .split('\n');
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const runtime = dockerfile.slice(dockerfile.indexOf(' AS runtime'));

  expect(dockerignore).toEqual(
    expect.arrayContaining([`!plugins/${id}/`, `!plugins/${id}/**`]),
  );
  expect(runtime).toContain(
    `COPY --link --from=builder /app/plugins/${id} ./plugins/${id}\n`,
  );
});
