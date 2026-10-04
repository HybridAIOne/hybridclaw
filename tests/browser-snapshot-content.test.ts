import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-browser-content-');
useCleanMocks({ resetModules: true, unstubAllEnvs: true });

async function snapshot(text: string) {
  const root = makeTempDir();
  const fixture = path.join(root, 'snapshot.txt');
  fs.writeFileSync(fixture, text);
  const runner = path.join(root, 'browser.mjs');
  fs.writeFileSync(
    runner,
    `#!/usr/bin/env node
import fs from 'node:fs';
const command = process.argv[process.argv.indexOf('--json') + 1];
process.stdout.write(JSON.stringify({ data: command === 'snapshot' ? {
  snapshot: fs.readFileSync(process.env.SNAPSHOT_FIXTURE, 'utf8'),
  refs: { e1: { role: 'button', name: 'Search' } },
  url: 'https://example.com/search'
} : [] }));
`,
  );
  fs.chmodSync(runner, 0o755);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
  vi.stubEnv('AGENT_BROWSER_BIN', runner);
  vi.stubEnv('SNAPSHOT_FIXTURE', fixture);
  const { executeBrowserTool } = await import('../container/src/browser-tools.js');
  return JSON.parse(
    await executeBrowserTool(
      'browser_snapshot',
      { mode: 'full' },
      'content-test',
    ),
  );
}

test('keeps a long form and its trailing submit control in the same snapshot', async () => {
  const calendar = Array.from({ length: 160 }, (_, index) =>
    `- gridcell "Date ${index}"\n  - checkbox "Date ${index}" [ref=date${index}]\n  - StaticText "Date ${index}"`,
  ).join('\n');
  const submit = '- button "Search" [ref=e1]';
  const result = await snapshot(`${calendar}\n${submit}`);
  expect(calendar.length).toBeGreaterThan(12_000);
  expect(result.truncated).toBe(false);
  expect(result.snapshot).toContain(submit);
});

test('keeps the snapshot bounded and announces when a large page is incomplete', async () => {
  const text = '- link "Example" [ref=e1, url=https://example.com/]\n'.repeat(6000);
  const result = await snapshot(text);
  expect(result.truncated).toBe(true);
  expect(result.snapshot.length).toBeLessThan(text.length);
  expect(result.snapshot).toContain('Snapshot truncated');
});
