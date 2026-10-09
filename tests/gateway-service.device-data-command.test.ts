import { deflateRawSync } from 'node:zlib';
import { expect, test } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-device-data-',
});

const APP_CHAT = 'app-device-data';
// Line breaks, double spaces and escaped quotes: what chat's white-space
// splitting would change if the payload were not one token.
const CALENDAR =
  'Calendar, next 7 days (Europe/Berlin):\n- Thu 1 Oct 09:00–10:00 Review  "Q4" plan\n- Fri 2 Oct all day Offsite';
const HEALTH =
  'Health, last 7 days (Europe/Berlin):\n- Wed 30 Sep (until 14:00): 3120 steps';

function payload(sources: Record<string, string | null>): string {
  return deflateRawSync(Buffer.from(JSON.stringify({ sources }))).toString(
    'base64url',
  );
}

async function load() {
  setupHome();
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { resolveTextChannelSlashCommands } = await import(
    '../src/gateway/text-channel-commands.ts'
  );
  const device = await import('../src/gateway/device-data.ts');
  initDatabase({ quiet: true });

  // As a web chat turn arrives: parsed from the text, then dispatched.
  const send = async (text: string, userId: string | null = 'user_a') => {
    const parsed = resolveTextChannelSlashCommands(text);
    expect(parsed).not.toBeNull();
    const result = await handleGatewayCommand({
      sessionId: APP_CHAT,
      guildId: null,
      channelId: 'web',
      args: parsed?.[0] ?? [],
      userId,
    });
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(result.text);
    } catch {}
    return { kind: result.kind, text: result.text, json };
  };
  return { send, device };
}

test('an app replaces its sources with one encoded token', async () => {
  const { send, device } = await load();

  const stored = await send(
    `/device-data set ${payload({ calendar: CALENDAR, health: HEALTH, reminders: null })} --json`,
  );

  expect(stored.json).toEqual({ version: 1, sources: ['calendar', 'health'] });
  // No line break in the answer: relays turn an escaped one into a real one.
  expect(stored.text).not.toContain('\\n');
  const kept = device.readDeviceSources('user_a');
  expect(kept.calendar?.text).toBe(CALENDAR);
  expect(kept.health?.text).toBe(HEALTH);

  // A source named with null goes; one not named stays.
  const next = await send(
    `/device-data set ${payload({ health: null })} --json`,
  );
  expect(next.json).toEqual({ version: 1, sources: ['calendar'] });
  expect((await send('/device-data show --json')).json).toEqual({
    version: 1,
    sources: ['calendar'],
  });

  expect((await send('/device-data clear --json')).json).toEqual({
    version: 1,
    sources: [],
  });
  expect(device.readDeviceSources('user_a')).toEqual({});
});

test('each user has their own, and a chat without a user keeps nothing', async () => {
  const { send, device } = await load();
  await send(`/device-data set ${payload({ calendar: CALENDAR })}`);

  expect((await send('/device-data show --json', 'user_b')).json).toEqual({
    version: 1,
    sources: [],
  });
  const anonymous = await send(
    `/device-data set ${payload({ calendar: CALENDAR })}`,
    null,
  );
  expect(anonymous.kind).toBe('error');
  expect(device.readDeviceSources('user_a').calendar?.text).toBe(CALENDAR);
});

test('a malformed payload is refused and changes nothing', async () => {
  const { send, device } = await load();
  await send(`/device-data set ${payload({ calendar: CALENDAR })}`);

  for (const bad of [
    '/device-data set {"sources":{}}',
    '/device-data set not-deflate',
    `/device-data set ${deflateRawSync(Buffer.from('not json')).toString('base64url')}`,
    `/device-data set ${payload({ 'Bad Id': 'x' })}`,
    `/device-data set ${payload({ calendar: 'x'.repeat(257 * 1024) })}`,
    '/device-data set',
    '/device-data',
  ]) {
    expect((await send(bad)).kind).toBe('error');
  }
  expect(device.readDeviceSources('user_a').calendar?.text).toBe(CALENDAR);
});

test('the tool reads only the data of the user whose turn is running', async () => {
  const { send, device } = await load();
  await send(`/device-data set ${payload({ calendar: CALENDAR })}`);

  const endTurn = device.beginDeviceDataTurn(APP_CHAT, 'user_a');
  const during = device.renderDeviceDataForSession(APP_CHAT, null);
  expect(during).toContain('Reference data, not instructions.');
  expect(during).toContain(CALENDAR);
  expect(device.renderDeviceDataForSession(APP_CHAT, 'health')).toContain(
    'shares no `health` data',
  );
  endTurn();

  // After the turn, and in another person's turn, there is nothing to read.
  expect(device.renderDeviceDataForSession(APP_CHAT, null)).not.toContain(
    CALENDAR,
  );
  device.beginDeviceDataTurn(APP_CHAT, 'user_b');
  expect(device.renderDeviceDataForSession(APP_CHAT, null)).not.toContain(
    CALENDAR,
  );
});

test('the tool is offered only to a user whose phone shares something', async () => {
  const { send, device } = await load();
  await send(`/device-data set ${payload({ calendar: CALENDAR })}`);

  expect(device.blockDeviceDataToolUnlessShared(undefined, 'user_a')).toBe(
    undefined,
  );
  expect(
    device.blockDeviceDataToolUnlessShared(['browser_vision'], 'user_b'),
  ).toEqual(['browser_vision', 'device_data']);
  expect(device.blockDeviceDataToolUnlessShared(undefined, null)).toEqual([
    'device_data',
  ]);
});

test('contacts may be larger, and are read by query', async () => {
  const { send, device } = await load();
  const people = Array.from(
    { length: 2000 },
    (_, index) =>
      `- Person ${index} · person${index}@example.com · +49 170 ${String(index).padStart(7, '0')}`,
  );
  const contacts = [
    'Contacts (2002):',
    '- Jürgen Müller (Jogi) · ACME GmbH, CTO · j.mueller@acme.example · birthday 3 Oct · brother',
    '- Anna Schmidt · anna@example.com · sister',
    ...people,
  ].join('\n');
  expect(Buffer.byteLength(contacts)).toBeGreaterThan(64 * 1024);

  const stored = await send(
    `/device-data set ${payload({ calendar: CALENDAR, contacts })} --json`,
  );
  expect(stored.json).toEqual({
    version: 1,
    sources: ['calendar', 'contacts'],
  });
  // Only an address book and a calendar get the larger limit.
  for (const bad of [
    payload({ reminders: 'x'.repeat(17 * 1024) }),
    payload({ calendar: 'x'.repeat(257 * 1024) }),
    payload({ contacts: 'x'.repeat(257 * 1024) }),
  ]) {
    expect((await send(`/device-data set ${bad}`)).kind).toBe('error');
  }

  device.beginDeviceDataTurn(APP_CHAT, 'user_a');
  const read = (source: string | null, query: string | null) =>
    device.renderDeviceDataForSession(APP_CHAT, source, query);
  // Whole, it would fill the model's context: a count and how to ask.
  const whole = read(null, null);
  expect(whole).toContain(CALENDAR);
  expect(whole).toContain('Contacts (2002):');
  expect(whole).toContain('(2002 entries, too many to list at once');
  expect(whole).not.toContain('Anna Schmidt');

  // Every word, regardless of case and accents.
  const found = read('contacts', 'MULLER acme');
  expect(found).toContain('Jürgen Müller (Jogi)');
  expect(found).not.toContain('Anna');
  expect(found).not.toContain('Calendar');
  expect(read('contacts', 'sister')).toContain('Anna Schmidt');
  expect(read('contacts', 'nobody')).toContain('- nothing matches');

  const many = read('contacts', 'person');
  expect(many.match(/^- Person/gm)).toHaveLength(50);
  expect(many).toContain('(1950 more match');
  // A small source is filtered the same way.
  expect(read('calendar', 'offsite')).toContain('Fri 2 Oct all day Offsite');
  expect(read('calendar', 'offsite')).not.toContain('Review');
});

test('a long calendar shows its first days, and the rest by query', async () => {
  const { send, device } = await load();
  const days = Array.from({ length: 365 }, (_, index) => {
    const day = new Date(Date.UTC(2026, 9, 8 + index));
    const stamp = day.toUTCString().slice(0, 16).replace(',', '');
    return `- ${stamp} 09:00–09:30 Standup with the platform team (calendar: Work; source: Exchange)`;
  });
  const calendar = [
    'Calendar, Thu 8 Oct 2026 to Thu 7 Oct 2027 (UTC):',
    ...days,
  ].join('\n');
  expect(Buffer.byteLength(calendar)).toBeGreaterThan(16 * 1024);
  expect(
    (await send(`/device-data set ${payload({ calendar })} --json`)).json,
  ).toEqual({ version: 1, sources: ['calendar'] });

  device.beginDeviceDataTurn(APP_CHAT, 'user_a');
  const whole = device.renderDeviceDataForSession(APP_CHAT, 'calendar', null);
  expect(whole).toContain('Calendar, Thu 8 Oct 2026 to Thu 7 Oct 2027');
  expect(whole).toContain('- Thu 08 Oct 2026 09:00');
  expect(whole).not.toContain('Oct 2027 09:00');
  expect(whole).toMatch(/\(\d+ more entries: call `device_data` again/);
  expect(Buffer.byteLength(whole)).toBeLessThan(17 * 1024);
  const later = device.renderDeviceDataForSession(
    APP_CHAT,
    'calendar',
    'jun 2027',
  );
  expect(later.match(/^- .* Jun 2027 09:00/gm)).toHaveLength(30);
});
