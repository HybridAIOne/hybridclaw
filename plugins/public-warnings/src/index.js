/**
 * Official German warnings for places the user names in chat. The agent
 * watches a place with the `public_warnings` tool; every 10 minutes the
 * watcher asks NINA for each watched district and posts each new warning as
 * the agent's message in its main chat, which rings the phones like a
 * reminder. The message keeps the official wording, instructions and link:
 * it is written without a model turn, so it arrives when the model or its
 * provider is down.
 *
 * NOT a replacement for Cell Broadcast or the official warning apps: polling
 * adds up to 10 minutes, and a gateway that is down sends nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DISTRICT_PATTERN,
  districtName,
  districtWarnings,
  searchPlaces,
  warningDetail,
} from './nina.js';

const PLUGIN_ID = 'public-warnings';
const POLL_MS = 10 * 60 * 1000;
const MAX_PLACES = 10;
const MAX_ADVICE_CHARS = 600;
const TIME_FORMAT = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const TOOL = {
  name: 'public_warnings',
  description:
    'Official German public warnings (NINA: civil protection, KATWARN, BIWAPP, DWD weather, floods, police) for a town or district in Germany. "check" lists current warnings; "watch" makes you message the user in this chat as soon as a new warning starts there (yellow weather warnings excepted); "unwatch" stops that; "list" shows watched places; "search" finds district keys when a name is ambiguous. Offer "watch" when the user wants to be warned about a place. Messages keep the official German text unless language is set.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['check', 'watch', 'unwatch', 'list', 'search'],
      },
      place: {
        type: 'string',
        description: 'Town, city or district in Germany, e.g. "Köln".',
      },
      district: {
        type: 'string',
        description:
          '5-digit district key from a search result; use it when several places match.',
      },
      label: {
        type: 'string',
        description:
          'watch: how to name the place in warnings, e.g. "Home" or the town.',
      },
      language: {
        type: 'string',
        description:
          'watch: two-letter code of the language the user writes in; official translations exist for en, ar, es, fr, pl, ru, tr. Default de.',
      },
    },
    required: ['action'],
  },
};

function warningKey(warning) {
  return `${warning.id}|${warning.severity}`;
}

// Yellow DWD warnings (frost, gusts) come several times a week; they stay
// visible through "check" but never ring a phone.
function isQuiet(warning) {
  return warning.source === 'DWD' && warning.severity === 'Minor';
}

function plainText(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clip(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : TIME_FORMAT.format(date);
}

async function warningMessage(place, warning) {
  const info = await warningDetail(warning.id, place.language).catch(
    () => null,
  );
  const onset = formatTime(info?.onset);
  const expires = formatTime(info?.expires);
  return [
    `⚠️ ${place.label}: ${plainText(info?.headline) || warning.headline}`,
    onset || expires ? `${onset} → ${expires}`.trim() : '',
    clip(
      plainText(info?.instruction) || plainText(info?.description),
      MAX_ADVICE_CHARS,
    ),
    warning.link,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function createStore(filePath) {
  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed?.version === 1 && parsed.agents) return parsed;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return { version: 1, agents: {} };
  }
  function save(state) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temp, filePath);
  }
  return { load, save };
}

async function resolvePlace(args) {
  const district = String(args.district ?? '').trim();
  if (district) {
    if (!DISTRICT_PATTERN.test(district))
      throw new Error('A district key has five digits.');
    const name = await districtName(district);
    if (!name) throw new Error(`No German district has the key ${district}.`);
    return { district, name };
  }
  const query = String(args.place ?? '').trim();
  if (!query) throw new Error('Name a place or pass a district key.');
  const matches = await searchPlaces(query);
  if (matches.length === 0)
    throw new Error(
      `No town or district in Germany matches "${query}". Only places in Germany are covered.`,
    );
  if (new Set(matches.map((match) => match.district)).size > 1)
    return { candidates: matches };
  return { district: matches[0].district, name: matches[0].place };
}

const AMBIGUOUS =
  'Several places match. Ask which one if unclear, then call again with its district.';

export default {
  id: PLUGIN_ID,
  register(api) {
    const store = createStore(
      path.join(
        api.runtime.homeDir,
        'data',
        'plugins',
        PLUGIN_ID,
        'places.json',
      ),
    );

    const actions = {
      async search(args) {
        return { candidates: await searchPlaces(args.place) };
      },
      async check(args) {
        const place = await resolvePlace(args);
        if (place.candidates) return { ...place, note: AMBIGUOUS };
        return { ...place, warnings: await districtWarnings(place.district) };
      },
      async watch(args, agentId) {
        const place = await resolvePlace(args);
        if (place.candidates) return { ...place, note: AMBIGUOUS };
        const warnings = await districtWarnings(place.district);
        const language = /^[a-z]{2}$/.test(String(args.language))
          ? args.language
          : 'de';
        const label =
          String(args.label ?? '')
            .trim()
            .slice(0, 60) || place.name;
        const state = store.load();
        state.agents[agentId] ??= { places: [] };
        const places = state.agents[agentId].places;
        const existing = places.find(
          (item) => item.district === place.district,
        );
        if (!existing && places.length >= MAX_PLACES)
          throw new Error(`At most ${MAX_PLACES} places can be watched.`);
        // Warnings already out are answered now; only later ones ring.
        const seen = warnings.map(warningKey);
        if (existing) Object.assign(existing, { label, language, seen });
        else places.push({ district: place.district, label, language, seen });
        store.save(state);
        return { watching: label, district: place.district, warnings };
      },
      async unwatch(args, agentId) {
        const place = await resolvePlace(args);
        if (place.candidates) return { ...place, note: AMBIGUOUS };
        const state = store.load();
        const places = state.agents[agentId]?.places ?? [];
        const index = places.findIndex(
          (item) => item.district === place.district,
        );
        if (index < 0) throw new Error(`${place.name} is not watched.`);
        const [removed] = places.splice(index, 1);
        store.save(state);
        return { stopped: removed.label };
      },
      async list(_args, agentId) {
        const places = store.load().agents[agentId]?.places ?? [];
        return {
          places: places.map(({ district, label, language }) => ({
            district,
            label,
            language,
          })),
        };
      },
    };

    api.registerTool({
      ...TOOL,
      async handler(args, context) {
        const action = actions[args.action];
        if (!action) throw new Error(`Unknown action "${args.action}".`);
        const agentId = api.resolveSessionAgentId(context.sessionId);
        return JSON.stringify(await action(args, agentId));
      },
    });

    async function poll() {
      const state = store.load();
      const watched = Object.entries(state.agents).flatMap(([agentId, entry]) =>
        entry.places.map((place) => ({ agentId, place })),
      );
      const current = new Map();
      for (const district of new Set(
        watched.map(({ place }) => place.district),
      )) {
        try {
          current.set(district, await districtWarnings(district));
        } catch (error) {
          api.logger.warn({ error, district }, 'NINA warning check failed');
        }
      }
      const updates = [];
      for (const { agentId, place } of watched) {
        const warnings = current.get(place.district);
        if (!warnings) continue;
        for (const warning of warnings) {
          if (place.seen.includes(warningKey(warning)) || isQuiet(warning))
            continue;
          try {
            const text = await warningMessage(place, warning);
            if (!api.postToMainChat(agentId, text, warning.id))
              api.logger.info({ agentId }, 'No main chat for a public warning');
          } catch (error) {
            api.logger.warn({ error, agentId }, 'Could not post a warning');
          }
        }
        updates.push({ agentId, district: place.district, warnings });
      }
      // The tool may have changed the list while warnings were fetched.
      const latest = store.load();
      for (const { agentId, district, warnings } of updates) {
        const place = latest.agents[agentId]?.places.find(
          (item) => item.district === district,
        );
        if (place) place.seen = warnings.map(warningKey);
      }
      if (updates.length > 0) store.save(latest);
    }

    let timer = null;
    let running = null;
    const tick = () => {
      running ??= poll()
        .catch((error) => api.logger.warn({ error }, 'Warning watcher failed'))
        .finally(() => {
          running = null;
        });
      return running;
    };
    api.registerService({
      id: 'public-warnings-watcher',
      async start() {
        timer = setInterval(tick, POLL_MS);
        timer.unref?.();
        void tick();
      },
      async stop() {
        if (timer) clearInterval(timer);
        timer = null;
        await running;
      },
    });
  },
};
