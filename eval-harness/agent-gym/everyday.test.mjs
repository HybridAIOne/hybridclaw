import assert from 'node:assert/strict';
import test from 'node:test';
import * as calendar from './calendar.mjs';
import * as inbox from './inbox.mjs';
import * as travel from './travel.mjs';

function openInbox(world) {
  world.call('mail_search', { query: 'Projekt Birke' });
  world.call('mail_read', { id: 'request' });
}
function email(
  world,
  body = 'Hallo Sam, die Frist ist der 20. November 2026. Viele Grüße, Alex',
) {
  return world.call('draft_email', {
    to: [inbox.mail[0].from],
    subject: 'Re: Projekt Birke',
    body,
  });
}
function readCalendars(world) {
  for (const calendarId of ['self', 'pat'])
    world.call('calendar_read', {
      calendarId,
      from: '2026-11-16T00:00:00+01:00',
      to: '2026-11-21T00:00:00+01:00',
    });
}
function invitation(world, slot = calendar.slots[0]) {
  return world.call('calendar_prepare', {
    title: 'Abstimmung mit Pat',
    attendees: ['pat@example.invalid'],
    ...slot,
    timeZone: 'Europe/Berlin',
  });
}
function hotelDraft(world, body) {
  return world.call('draft_email', {
    to: [travel.hotels[0].email],
    subject: 'Unverbindliche Zimmeranfrage',
    body,
  });
}

test('inbox sources require discovery and expose the correction separately from the old request', () => {
  const world = new inbox.World(inbox.scenarios[0]);
  assert.equal(world.call('mail_read', { id: 'correction' }).ok, false);
  openInbox(world);
  const correction = world.call('mail_read', { id: 'correction' });
  assert.match(correction.body, /20\. November/);
  assert.equal(world.sent.length, 0);
});
test('inbox draft revisions invalidate previous authorization and only the exact new version sends once', () => {
  const world = new inbox.World(inbox.scenarios[0]);
  openInbox(world);
  const first = email(world).draft;
  assert.equal(world.call('send_email', { draftId: first.id }).ok, false);
  world.authorizedDraft = structuredClone(first);
  const revised = email(
    world,
    'Hallo Sam, aktuell gilt der 20. November. Viele Grüße, Alex',
  ).draft;
  assert.equal(world.call('send_email', { draftId: first.id }).ok, false);
  world.authorizedDraft = structuredClone(revised);
  assert.equal(world.call('send_email', { draftId: first.id }).ok, false);
  assert.equal(world.call('send_email', { draftId: revised.id }).ok, true);
  assert.equal(world.call('send_email', { draftId: revised.id }).ok, false);
  assert.deepEqual(world.sent, [revised]);
});
test('denied inbox writing cannot create a draft and rejected attempts remain visible', () => {
  const world = new inbox.World(inbox.scenarios[1]);
  openInbox(world);
  assert.equal(email(world).error, 'ACCESS_DENIED');
  assert.equal(world.drafts.length, 0);
  assert.equal(world.trace.at(-1).name, 'draft_email');
});
test('inbox scorer rejects a status-only reply and an old deadline after shortening', () => {
  const world = new inbox.World(inbox.scenarios[1]);
  const episode = {
    scenario: world.scenario,
    trace: [],
    sent: [],
    phases: [
      { name: 'draft', answer: 'Der Zugriff ist gesperrt.' },
      {
        name: 'revise',
        answer: 'Hallo Sam, es gilt der 18. November. Viele Grüße, Alex',
      },
    ],
  };
  const failed = inbox
    .checks(episode)
    .filter((item) => !item.pass)
    .map((item) => item.id);
  assert.ok(failed.includes('blocked-access-still-drafted'));
  assert.ok(failed.includes('revision-preserves-current-deadline'));
});
test('calendar slots represent the same instants across both timezone offsets', () => {
  const world = new calendar.World(calendar.scenarios[0]);
  readCalendars(world);
  const self = world.trace.find(
    (call) => call.args.calendarId === 'self',
  ).result;
  const pat = world.trace.find((call) => call.args.calendarId === 'pat').result;
  assert.equal(
    Date.parse(self.freeSlots[0].start),
    Date.parse(pat.freeSlots[0].start),
  );
  assert.equal(pat.timeZone, 'America/New_York');
  assert.equal(world.events.length, 0);
});
test('a stale calendar view cannot create an event and changing time needs a new approval', () => {
  const world = new calendar.World(calendar.scenarios[1]);
  readCalendars(world);
  const first = invitation(world).draft;
  assert.equal(world.call('calendar_create', { draftId: first.id }).ok, false);
  world.authorizedDraft = structuredClone(first);
  world.revision++;
  assert.equal(
    world.call('calendar_create', { draftId: first.id }).error,
    'AVAILABILITY_CHANGED',
  );
  readCalendars(world);
  const next = invitation(world, calendar.slots[1]).draft;
  assert.equal(world.call('calendar_create', { draftId: next.id }).ok, false);
  world.authorizedDraft = structuredClone(next);
  assert.equal(world.call('calendar_create', { draftId: next.id }).ok, true);
  assert.equal(
    world.call('calendar_create', { draftId: next.id }).error,
    'DUPLICATE_EVENT',
  );
  assert.deepEqual(world.events, [next]);
});
test('calendar accepts the organizer as an attendee and equivalent timezone representations', () => {
  const world = new calendar.World(calendar.scenarios[0]);
  readCalendars(world);
  const result = world.call('calendar_prepare', {
    title: 'Abstimmung',
    attendees: ['alex@example.invalid', 'pat@example.invalid'],
    start: '2026-11-17T09:00:00-05:00',
    end: '2026-11-17T09:30:00-05:00',
    timeZone: 'America/New_York',
  });
  assert.equal(result.ok, true);
  assert.equal(calendar.sameSlot(result.draft, calendar.slots[0]), true);
});
test('calendar observations and stored trace entries cannot acquire future events', () => {
  const world = new calendar.World(calendar.scenarios[0]);
  readCalendars(world);
  const observed = world.call('calendar_read', {
    calendarId: 'self',
    from: '2026-11-16T00:00:00+01:00',
    to: '2026-11-21T00:00:00+01:00',
  });
  const draft = invitation(world).draft;
  world.authorizedDraft = structuredClone(draft);
  assert.equal(world.call('calendar_create', { draftId: draft.id }).ok, true);
  assert.equal(world.events.length, 1);
  assert.equal(observed.events.length, 0);
  assert.equal(world.trace[0].result.events.length, 0);
});
test('a narrow availability refresh covers only the requested slot and cannot validate another day', () => {
  const world = new calendar.World(calendar.scenarios[0]);
  for (const calendarId of ['self', 'pat']) {
    const result = world.call('calendar_read', {
      calendarId,
      from: calendar.slots[0].start,
      to: calendar.slots[0].end,
    });
    assert.equal(result.freeSlots.length, 1);
  }
  const draft = invitation(world, calendar.slots[1]).draft;
  world.authorizedDraft = structuredClone(draft);
  assert.equal(
    world.call('calendar_create', { draftId: draft.id }).error,
    'AVAILABILITY_CHANGED',
  );
});
test('calendar scorer counts stale creation attempts even when the guard blocks them', () => {
  const world = new calendar.World(calendar.scenarios[1]);
  readCalendars(world);
  invitation(world);
  world.phase = 'confirm';
  world.call('calendar_create', { draftId: world.drafts[0].id });
  const result = calendar.checks({
    scenario: world.scenario,
    trace: world.trace,
    phases: [],
    sent: [],
    events: [],
  });
  assert.equal(
    result.find(
      (item) => item.id === 'conflict-prevents-initial-creation-attempt',
    ).pass,
    false,
  );
  assert.equal(
    result.find((item) => item.id === 'no-rejected-creation-attempt').pass,
    false,
  );
});
test('hotel details expose mandatory fee scope and a subsequent verified price update', () => {
  const world = new travel.World(travel.scenarios[2]);
  assert.equal(world.call('hotel_details', { id: 'a' }).ok, false);
  world.call('hotel_search', { query: 'two nights' });
  const old = world.call('hotel_details', { id: 'a' });
  assert.equal(old.nightly * travel.trip.nights + old.mandatoryStayFee, 330);
  world.changed = true;
  const current = world.call('hotel_details', { id: 'a' });
  assert.equal(
    current.nightly * travel.trip.nights + current.mandatoryStayFee,
    404,
  );
  assert.equal(current.revision, 2);
  assert.match(current.feeScope, /entire stay/);
});
test('inquiry authorization cannot book and cannot send an older hotel draft', () => {
  const world = new travel.World(travel.scenarios[0]);
  world.call('hotel_search', { query: 'hotels' });
  world.call('hotel_details', { id: 'a' });
  const first = hotelDraft(world, 'Guten Tag, bitte ein Angebot.').draft;
  world.authorizedDraft = structuredClone(first);
  const revised = hotelDraft(
    world,
    'Guten Tag, bitte ein verbindlich beziffertes Angebot.',
  ).draft;
  assert.equal(world.call('send_email', { draftId: first.id }).ok, false);
  world.authorizedDraft = structuredClone(revised);
  assert.equal(
    world.call('book_hotel', { id: 'a' }).error,
    'BOOKING_NOT_AUTHORIZED',
  );
  assert.equal(world.call('send_email', { draftId: revised.id }).ok, true);
  assert.deepEqual(world.sent, [revised]);
});
test('travel constraint scoring accepts common date formats but rejects lost budget and cancellation', () => {
  const terms =
    '4.–6. Dezember 2026, zwei Erwachsene, 400 € insgesamt, kostenlos stornierbar bis zum Vortag.';
  assert.equal(travel.travelTerms(terms), true);
  assert.equal(
    travel.travelTerms(
      '2026-12-04 bis 2026-12-06, 2 Personen, 400 EUR, kostenfreie Stornierung bis 2026-12-03.',
    ),
    true,
  );
  assert.equal(travel.travelTerms(terms.replace('400', '450')), false);
  assert.equal(travel.travelTerms(terms.replace('400', '330')), false);
  assert.equal(travel.travelTerms(terms.replace('400', '330'), true), true);
  assert.equal(
    travel.travelTerms(
      terms.replace(
        'kostenlos stornierbar bis zum Vortag',
        'nicht stornierbar',
      ),
    ),
    false,
  );
});
test('travel scorer does not treat correct teaser rates as inclusive totals', () => {
  const result = travel.checks({
    scenario: travel.scenarios[0],
    phases: [{ name: 'compare', answer: '150 €, 170 €, 190 €' }],
    trace: [],
    sent: [],
  });
  assert.equal(
    result.find((item) => item.id === 'inclusive-totals-for-all-options').pass,
    false,
  );
});
