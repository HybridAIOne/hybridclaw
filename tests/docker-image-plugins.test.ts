import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

function imagePluginCopies(): string[] {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf-8');
  return [
    ...dockerfile.matchAll(
      /^COPY .*--from=builder \/app\/plugins\/([\w-]+) \.\/plugins\/\1$/gm,
    ),
  ].map((match) => match[1]);
}

// tier-router is enabled by routing.enabled and twilio-voice by the v0.39
// voice migration, both without an install step, so the image must carry
// them; a missing copy would also send `plugin install <id>` to npm.
test.each([
  'tier-router',
  'twilio-voice',
])('the gateway image ships plugins/%s', (pluginId) => {
  expect(imagePluginCopies()).toContain(pluginId);
});

test('every plugin the Dockerfile copies survives .dockerignore', () => {
  const ignore = fs
    .readFileSync(path.join(ROOT, '.dockerignore'), 'utf-8')
    .split('\n')
    .map((line) => line.trim());

  expect(ignore).toContain('plugins/*');
  for (const pluginId of imagePluginCopies()) {
    expect(ignore).toEqual(
      expect.arrayContaining([
        `!plugins/${pluginId}/`,
        `!plugins/${pluginId}/**`,
      ]),
    );
  }
});
