import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const ORIGINAL_HOME = process.env.HOME;

const makeTempHome = useTempDir('hybridclaw-apps-store-');

useCleanMocks({
  cleanup: () => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
  },
  resetModules: true,
});

async function setup() {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();
  const { initDatabase } = await import('../src/memory/db.ts');
  const store = await import('../src/memory/apps.ts');
  initDatabase({ quiet: true });
  return store;
}

test('createApp persists and getApp returns the stored html', async () => {
  const { createApp, getApp } = await setup();
  const created = createApp({
    title: 'Pomodoro Timer',
    html: '<!DOCTYPE html><html><body>hi</body></html>',
    description: 'A focus timer',
    category: 'productivity',
    prompt: 'build a pomodoro timer',
  });
  expect(created.id).toBeTruthy();
  expect(created.category).toBe('productivity');
  expect(created.visibility).toBe('private');

  const fetched = getApp(created.id);
  expect(fetched?.html).toContain('<body>hi</body>');
  expect(fetched?.title).toBe('Pomodoro Timer');
});

test('listApps omits html, filters by category and search, newest first', async () => {
  const { createApp, listApps } = await setup();
  createApp({ title: 'Snake Game', html: '<html></html>', category: 'games' });
  createApp({
    title: 'Invoice Doc',
    html: '<html></html>',
    category: 'documents',
    description: 'monthly invoice',
  });

  const all = listApps();
  expect(all).toHaveLength(2);
  // Summary rows do not carry the html body.
  expect((all[0] as unknown as { html?: string }).html).toBeUndefined();

  const games = listApps({ category: 'games' });
  expect(games).toHaveLength(1);
  expect(games[0].title).toBe('Snake Game');

  const bySearch = listApps({ search: 'invoice' });
  expect(bySearch).toHaveLength(1);
  expect(bySearch[0].title).toBe('Invoice Doc');
});

test('unknown category normalizes to apps', async () => {
  const { createApp } = await setup();
  const created = createApp({
    title: 'Mystery',
    html: '<html></html>',
    category: 'not-a-real-category',
  });
  expect(created.category).toBe('apps');
});

test('upsertAppArtifact creates then updates the same (session, source) entry', async () => {
  const { upsertAppArtifact, listApps, getApp } = await setup();
  const first = upsertAppArtifact({
    sessionId: 'sess-app-1',
    sourceKey: 'app.html',
    title: 'Draft',
    html: '<html><body>v1</body></html>',
    category: 'productivity',
    kind: 'live',
  });
  expect(listApps()).toHaveLength(1);
  expect(first.kind).toBe('live');

  const second = upsertAppArtifact({
    sessionId: 'sess-app-1',
    sourceKey: 'app.html',
    title: 'Final Dashboard',
    html: '<html><body>v2</body></html>',
    category: 'productivity',
    kind: 'live',
  });
  // Same row updated in place, not a duplicate.
  expect(second.id).toBe(first.id);
  expect(listApps()).toHaveLength(1);
  expect(getApp(first.id)?.html).toContain('v2');
  expect(getApp(first.id)?.title).toBe('Final Dashboard');

  // A different artifact in the same session is a separate entry.
  upsertAppArtifact({
    sessionId: 'sess-app-1',
    sourceKey: 'report.html',
    title: 'Report',
    html: '<html></html>',
  });
  expect(listApps()).toHaveLength(2);

  // A different session is also separate.
  upsertAppArtifact({
    sessionId: 'sess-app-2',
    sourceKey: 'app.html',
    title: 'Other',
    html: '<html></html>',
  });
  expect(listApps()).toHaveLength(3);
});

test('deleteApp removes the record', async () => {
  const { createApp, deleteApp, getApp } = await setup();
  const created = createApp({ title: 'Temp', html: '<html></html>' });
  expect(deleteApp(created.id)).toBe(true);
  expect(getApp(created.id)).toBeNull();
  expect(deleteApp(created.id)).toBe(false);
});
