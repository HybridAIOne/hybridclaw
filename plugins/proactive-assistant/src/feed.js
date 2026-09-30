/**
 * The proactive feed: what the user's app reads and what the background check
 * does with the connected account.
 *
 * Invariants:
 * - Served only to the HybridAI account whose connectors are read. Anyone else
 *   who can chat with this gateway (a workspace member, a Discord user) gets
 *   `not_owner`, because a suggestion quotes the owner's mail.
 * - Nothing is read until the owner switches the feed on; switching it off
 *   deletes the suggestions.
 * - A failed check leaves the cursors where they were, so the next one sees
 *   the same events. A settings change while a check runs discards its result.
 * - A suggestion is an editable draft. Nothing here runs one.
 *
 * NOT the heartbeat or the scheduler: those run agent turns with tools. A
 * check reads envelopes through two read-only connector tools and makes one
 * model request without tools (`assessment.js`).
 */
import { randomUUID } from 'node:crypto';

import { buildMessages, parseProposals } from './assessment.js';
import { CALENDAR_TOOL, GMAIL_TOOL } from './platform.js';
import { defaultSettings, emptyCursor, emptyState, prune } from './store.js';

const SOURCES = ['gmail', 'calendar'];
// Failed assessments of the same events before they are passed over, so one
// mail a provider always refuses cannot block the feed.
const MAX_ASSESSMENT_ATTEMPTS = 3;
// The app reads the feed while it is open; asking HybridAI what is connected
// on every read would be one request per refresh.
const SOURCES_MAX_AGE_MS = 60_000;
// 12 tries, one per check (engineering choice, 2026-09-30): an hour for a
// phone to register after a suggestion appears, then the feed alone shows it.
const MAX_PUSH_ATTEMPTS = 12;
// The tools cap a burst themselves; these bound what a changed tool could
// put in front of the model.
const MAX_EVENTS = 45;
const MAX_EVENT_CHARS = 2000;
const MAX_GOALS_CHARS = 4000;
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;

const STREAM_UNSAFE = { '\\\\': '\\u005c', '\\n': '\\u000a', '\\r': '\\u000d' };

/**
 * JSON that survives a chat text stream. Relays escape line breaks as the two
 * characters backslash-n, and their clients turn every such pair back into a
 * line break, which would corrupt a JSON string that holds an escaped one.
 */
export function wire(value) {
  return JSON.stringify(value).replace(
    /\\[\\nr]/g,
    (pair) => STREAM_UNSAFE[pair],
  );
}

/** Whether `moment` falls in the user's quiet hours. Equal hours: never. */
export function isQuiet(settings, moment) {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      hourCycle: 'h23',
      timeZone: settings.time_zone,
    }).format(moment),
  );
  const { quiet_start: start, quiet_end: end } = settings;
  if (start === end) return false;
  return start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}

function isTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The settings a client sent, or null when they are not acceptable. */
function decodeSettings(argument) {
  let raw;
  try {
    raw = JSON.parse(
      Buffer.from(String(argument || ''), 'base64url').toString('utf8'),
    );
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const settings = { ...defaultSettings() };
  for (const key of Object.keys(settings)) {
    if (raw[key] !== undefined) settings[key] = raw[key];
  }
  const hours = [settings.quiet_start, settings.quiet_end];
  const language = raw.language ?? null;
  // `enabled` has to be stated: switching off deletes the suggestions, which
  // an empty payload must not do by default.
  if (
    typeof raw.enabled !== 'boolean' ||
    typeof settings.goals !== 'string' ||
    settings.goals.length > MAX_GOALS_CHARS ||
    !hours.every((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23) ||
    typeof settings.time_zone !== 'string' ||
    settings.time_zone.length > 100 ||
    !isTimeZone(settings.time_zone) ||
    (language !== null &&
      (typeof language !== 'string' ||
        language.length > 16 ||
        !LANGUAGE_TAG.test(language)))
  )
    return null;
  settings.goals = settings.goals.trim();
  return { settings, language };
}

function eventsOf(result) {
  const list = Array.isArray(result?.events) ? result.events : [];
  return list
    .filter(
      (event) =>
        typeof event?.source === 'string' && typeof event?.text === 'string',
    )
    .map((event) => ({
      source: event.source.slice(0, 40),
      text: event.text.slice(0, MAX_EVENT_CHARS),
    }));
}

function cursorValue(result, key) {
  const value = result?.[key];
  if (typeof value !== 'string' || !value) {
    throw new Error(`The connector tool returned no ${key}.`);
  }
  return value;
}

export function createFeed({
  store,
  platform,
  getApiKey,
  assess,
  assistantName,
  logger,
  onSwitchedOn = () => {},
  now = () => new Date(),
}) {
  let loaded = null;
  let sourcesAt = 0;
  let running = false;

  // Read on first use, so registering the plugin touches no file.
  const state = () => {
    loaded ??= store.load();
    return loaded;
  };
  const save = () => store.save(state());
  const failure = (code) => ({ version: 1, failure: code });

  // The credential last confirmed, in memory only: nothing about it is stored.
  let confirmedKey = null;

  async function account() {
    const apiKey = getApiKey();
    if (!apiKey) return { failure: 'not_signed_in' };
    const known = state().account;
    if (known && apiKey === confirmedKey) return { id: known.id };
    let id;
    try {
      id = await platform.accountId();
    } catch (error) {
      logger.warn(
        { errorType: error?.name },
        'Could not confirm the HybridAI account of this gateway.',
      );
      return { failure: 'unavailable' };
    }
    // Another account signed in: its mail must not inherit these suggestions.
    if (known && known.id !== id) {
      loaded = emptyState();
      sourcesAt = 0;
    }
    confirmedKey = apiKey;
    if (state().account?.id !== id) {
      state().account = { id };
      save();
    }
    return { id };
  }

  async function refreshSources(maxAgeMs) {
    if (now().getTime() - sourcesAt < maxAgeMs) return true;
    let names;
    try {
      names = await platform.toolNames();
    } catch (error) {
      logger.warn(
        { errorType: error?.name },
        'Could not ask HybridAI which sources are connected.',
      );
      return false;
    }
    sourcesAt = now().getTime();
    const next = {
      gmail: names.has(GMAIL_TOOL),
      calendar: names.has(CALENDAR_TOOL),
    };
    const current = state().sources;
    if (SOURCES.some((id) => next[id] !== current[id])) {
      state().sources = next;
      save();
    }
    return true;
  }

  function snapshot() {
    const { settings, sources, suggestions, last_checked_at, error } = state();
    return {
      version: 1,
      settings,
      sources: SOURCES.map((id) => ({ id, available: sources[id] === true })),
      suggestions: settings.enabled
        ? suggestions
            .filter((item) => item.status === 'pending')
            .map(({ id, source, title, detail, why, prompt, created_at }) => ({
              id,
              source,
              title,
              detail,
              why,
              prompt,
              created_at,
            }))
        : [],
      last_checked_at,
      error,
    };
  }

  function configure(argument) {
    const input = decodeSettings(argument);
    if (!input) return failure('invalid_settings');
    const current = state();
    const switchedOn = input.settings.enabled && !current.settings.enabled;
    current.settings = input.settings;
    if (input.language) current.language = input.language;
    current.revision += 1;
    current.error = null;
    current.assessment_failures = 0;
    if (!input.settings.enabled) current.suggestions = [];
    if (!input.settings.enabled || switchedOn) {
      // "New" starts from the moment the feed is switched on.
      current.cursor = emptyCursor();
      current.last_checked_at = null;
    }
    save();
    if (switchedOn) onSwitchedOn();
    return snapshot();
  }

  function close(id, status) {
    const item = state().suggestions.find((entry) => entry.id === id);
    if (!item) return failure('not_found');
    item.status = status;
    save();
    return snapshot();
  }

  const operations = {
    async feed() {
      // Stale availability is still an answer; the read must not fail on it.
      await refreshSources(SOURCES_MAX_AGE_MS);
      return snapshot();
    },
    configure,
    dismiss: (id) => close(id, 'dismissed'),
    review: (id) => close(id, 'reviewed'),
  };

  /** `proactive feed | configure <base64url JSON> | dismiss <id> | review <id>` */
  async function command(args, context) {
    const owner = await account();
    if (owner.failure) return wire(failure(owner.failure));
    if (!context?.userId || context.userId !== owner.id) {
      return wire(failure('not_owner'));
    }
    const [operation = 'feed', argument, ...rest] = args;
    if (!Object.hasOwn(operations, operation) || rest.length > 0) {
      return wire(failure('unknown_operation'));
    }
    return wire(await operations[operation](argument));
  }

  async function readSources(cursor, sources) {
    const next = emptyCursor();
    const events = [];
    // A source that cannot be watched keeps no cursor, so granting it later
    // starts from that moment instead of replaying the gap.
    if (sources.gmail) {
      const result = await platform.callTool(
        GMAIL_TOOL,
        cursor.history_id ? { history_id: cursor.history_id } : {},
      );
      next.history_id = cursorValue(result, 'history_id');
      events.push(...eventsOf(result));
    }
    if (sources.calendar) {
      const result = await platform.callTool(CALENDAR_TOOL, {
        ...(cursor.synced_at ? { synced_at: cursor.synced_at } : {}),
        ...(cursor.horizon ? { horizon: cursor.horizon } : {}),
      });
      next.synced_at = cursorValue(result, 'synced_at');
      next.horizon = cursorValue(result, 'horizon');
      events.push(...eventsOf(result));
    }
    return { next, events: events.slice(0, MAX_EVENTS) };
  }

  function fail(revision, code) {
    if (state().revision === revision) {
      state().error = code;
      save();
    }
    return 'failed';
  }

  async function look(moment) {
    const revision = state().revision;
    if (!(await refreshSources(0))) return fail(revision, 'source_unavailable');
    const sources = { ...state().sources };
    if (!sources.gmail && !sources.calendar) return 'not_connected';

    let read;
    try {
      read = await readSources({ ...state().cursor }, sources);
    } catch (error) {
      const reconnect = error?.reconnect === true;
      // The type only: a connector message can quote what it was asked for.
      logger.warn(
        { errorType: error?.name, reconnect },
        'Proactive check could not read the connected account.',
      );
      return fail(
        revision,
        reconnect ? 'reconnect_google' : 'source_unavailable',
      );
    }

    let proposals = [];
    if (read.events.length > 0) {
      try {
        const text = await assess(
          buildMessages({
            now: moment,
            settings: state().settings,
            language: state().language,
            events: read.events,
            previous: state().suggestions,
          }),
        );
        proposals = parseProposals(text, read.events.length);
      } catch (error) {
        if (state().revision !== revision) return 'superseded';
        const gaveUp =
          state().assessment_failures + 1 >= MAX_ASSESSMENT_ATTEMPTS;
        // The type only: the request, and some provider errors, quote mail.
        logger.warn(
          { errorType: error?.name, gaveUp },
          'Proactive assessment failed.',
        );
        if (!gaveUp) {
          state().assessment_failures += 1;
          return fail(revision, 'assessment_failed');
        }
      }
    }

    if (state().revision !== revision) return 'superseded';
    const current = state();
    const created = moment.toISOString();
    current.cursor = read.next;
    current.last_checked_at = created;
    current.error = null;
    current.assessment_failures = 0;
    for (const item of proposals) {
      current.suggestions.push({
        id: randomUUID(),
        // From the event it points at, never from the model's text.
        source: read.events[item.event].source,
        title: item.title,
        detail: item.detail,
        why: item.why,
        prompt: item.prompt,
        status: 'pending',
        created_at: created,
        pushed: false,
        push_attempts: 0,
      });
    }
    prune(current, moment.getTime());
    save();
    return 'checked';
  }

  async function pushPending() {
    const open = state().suggestions.filter(
      (item) => item.status === 'pending',
    );
    const due = open.filter(
      (item) => !item.pushed && item.push_attempts < MAX_PUSH_ATTEMPTS,
    );
    for (const item of due) {
      item.push_attempts += 1;
      try {
        // The lock screen shows this: the title only, never detail or prompt.
        const result = await platform.push({
          id: `proactive:${item.id}`,
          kind: 'proactive',
          title: assistantName,
          body: item.title,
          data: { id: item.id },
          badge: open.length,
        });
        if (result?.delivered === true || result?.reason === 'duplicate') {
          item.pushed = true;
        }
      } catch (error) {
        logger.warn({ errorType: error?.name }, 'Proactive push failed.');
      }
    }
    if (due.length > 0) save();
  }

  async function run() {
    const owner = await account();
    if (owner.failure) return owner.failure;
    const moment = now();
    if (prune(state(), moment.getTime())) save();
    if (!state().settings.enabled) return 'disabled';
    const quiet = isQuiet(state().settings, moment);
    // Quiet hours skip the look entirely, so what arrives overnight is still
    // new in the morning. The first look after switching on runs regardless:
    // it takes the mailbox bookmark that makes the night's mail count as new.
    if (quiet && state().last_checked_at !== null) return 'quiet';
    const outcome = await look(moment);
    if (!quiet && state().settings.enabled) await pushPending();
    return outcome;
  }

  /** Looks at the connected account once. Overlapping calls do nothing. */
  async function check() {
    if (running) return 'busy';
    running = true;
    try {
      return await run();
    } finally {
      running = false;
    }
  }

  return { command, check };
}
