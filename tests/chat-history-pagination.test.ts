import { expect, test } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-chat-pagination-',
});

async function setup() {
  setupHome();
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true });
  const { getGatewayHistory } = await import('../src/gateway/gateway-service.js');
  const session = db.getOrCreateSession('web:history', null, 'web');
  const other = db.getOrCreateSession('web:other-history', null, 'web');
  const add = (content: string, user = 'user_a') =>
    db.storeMessage(session.id, user, null, 'user', content);
  return { db, getGatewayHistory, session, other, add };
}

test('80-message cursors traverse complete history despite concurrent appends and foreign rows', async () => {
  const { db, getGatewayHistory, session, other, add } = await setup();
  const ids = Array.from({ length: 165 }, (_, i) => {
    db.storeMessage(other.id, 'user_b', null, 'user', 'Other conversation');
    return add(`Message ${i}`);
  });
  const first = getGatewayHistory(session.id, 80);
  expect(first.history.map((message) => message.id)).toEqual(ids.slice(-80));
  expect(first.nextCursor).toBe(String(ids[85]));
  add('Arrived while reading history');
  const pages = [...first.history];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = getGatewayHistory(session.id, 80, { beforeMessageId: Number(cursor) });
    pages.unshift(...page.history);
    cursor = page.nextCursor;
  }
  expect(pages.map((message) => message.id)).toEqual(ids);
  expect(new Set(pages.map((message) => message.id)).size).toBe(ids.length);
});

test('cursor advances across completely hidden pages and ends at the oldest stored row', async () => {
  const { getGatewayHistory, session, add } = await setup();
  const oldest = add('Oldest visible message');
  add('Internal task', 'scheduler');
  add('Internal task', 'scheduler');
  const first = getGatewayHistory(session.id, 2);
  expect(first.history).toEqual([]);
  expect(first.nextCursor).toBeTruthy();
  const last = getGatewayHistory(session.id, 2, { beforeMessageId: Number(first.nextCursor) });
  expect(last.history.map((message) => message.id)).toEqual([oldest]);
  expect(last.nextCursor).toBeNull();
  expect(getGatewayHistory(session.id, 2, { beforeMessageId: oldest }).history).toEqual([]);
});

test('page size stays bounded and cursors survive deletion of their anchor row', async () => {
  const { db, getGatewayHistory, session, add } = await setup();
  const ids = Array.from({ length: 205 }, (_, i) => add(`Message ${i}`));
  const page = getGatewayHistory(session.id, 1000);
  expect(page.history).toHaveLength(200);
  expect(page.nextCursor).toBe(String(ids[5]));
  db.deleteMessagesByIds(session.id, [ids[5]]);
  const oldest = getGatewayHistory(session.id, 200, { beforeMessageId: Number(page.nextCursor) });
  expect(oldest.history.map((message) => message.id)).toEqual(ids.slice(0, 5));
  expect(oldest.nextCursor).toBeNull();
  expect(getGatewayHistory('missing', 80)).toMatchObject({ history: [], nextCursor: null });
});
