/**
 * Official German warnings from the federal warning system (NINA, run by the
 * BBK). Its district dashboard joins every source NINA carries: MoWaS civil
 * protection, KATWARN, BIWAPP, DWD weather, flood centres and police. Place
 * names come from the DWD warn-cell list, the only keyless official list that
 * names every municipality and district with its official key.
 */

const NINA = 'https://warnung.bund.de';
const CELLS_URL =
  'https://www.dwd.de/DE/leistungen/opendata/help/warnungen/cap_warncellids_csv.csv?__blob=publicationFile';
const USER_AGENT =
  'hybridclaw-public-warnings/0.1 (+https://github.com/hybridaione/hybridclaw)';
const TIMEOUT_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CANDIDATES = 8;
// Type words in front of official names ("Stadt München", "Kreis Kleve").
const TYPE_PREFIX =
  /^(?:stadt|gemeinde|mitgliedsgemeinde|hansestadt|große kreisstadt|kreis|landkreis|region|städteregion|gemeindefreies gebiet)\s+/;
export const DISTRICT_PATTERN = /^\d{5}$/;

async function get(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`${new URL(url).host} answered HTTP ${response.status}.`);
  return response;
}

let placeIndex = null;

/**
 * Municipalities (warn cells `8` + 8-digit AGS) and districts (`1` + 5-digit
 * district key + `000`), refreshed daily so merged municipalities follow.
 */
async function places(now = Date.now()) {
  if (placeIndex && now - placeIndex.loadedAt < DAY_MS) return placeIndex;
  const text = await (await get(CELLS_URL)).text();
  const rows = [];
  const districtNames = new Map();
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/).slice(1)) {
    const [cell = '', name = '', , , state = ''] = line.split(';');
    if (!/^[18]\d{8}$/.test(cell) || !name) continue;
    const district = cell.slice(1, 6);
    const isDistrict = cell[0] === '1';
    if (isDistrict) districtNames.set(district, name);
    rows.push({ name, key: searchKey(name), district, state, isDistrict });
  }
  if (!districtNames.size) throw new Error('The DWD place list was empty.');
  placeIndex = { loadedAt: now, rows, districtNames };
  return placeIndex;
}

function searchKey(name) {
  return name.trim().toLowerCase().replace(TYPE_PREFIX, '');
}

function candidate(index, row) {
  return {
    district: row.district,
    place: row.name,
    districtName: index.districtNames.get(row.district) ?? row.name,
    state: row.state,
  };
}

/**
 * Places named `query` (municipalities before districts, so "München" is the
 * city), else places whose name starts with it.
 */
export async function searchPlaces(query) {
  const index = await places();
  const key = searchKey(String(query ?? ''));
  if (!key) return [];
  const exact = index.rows.filter((row) => row.key === key);
  const pick =
    exact.filter((row) => !row.isDistrict).length > 0
      ? exact.filter((row) => !row.isDistrict)
      : exact.length > 0
        ? exact
        : index.rows.filter((row) => row.key.startsWith(key));
  const seen = new Set();
  const result = [];
  for (const row of pick) {
    const id = `${row.district}:${row.name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(candidate(index, row));
    if (result.length === MAX_CANDIDATES) break;
  }
  return result;
}

/** The official name of a 5-digit district key, or null when there is none. */
export async function districtName(district) {
  return (await places()).districtNames.get(district) ?? null;
}

/** Warnings NINA lists for a district now, as short records. */
export async function districtWarnings(district) {
  if (!DISTRICT_PATTERN.test(district))
    throw new Error('A district key has five digits.');
  const list = await (
    await get(`${NINA}/api31/dashboard/${district}0000000.json`)
  ).json();
  if (!Array.isArray(list)) throw new Error('NINA sent no warning list.');
  return list
    .filter((entry) => entry?.payload?.data?.valid !== false && entry.id)
    .map((entry) => ({
      id: String(entry.id),
      source: entry.payload?.data?.provider ?? '',
      severity: entry.payload?.data?.severity ?? '',
      headline: entry.payload?.data?.headline ?? entry.i18nTitle?.de ?? '',
      sent: entry.sent ?? '',
      link: warningLink(entry.id),
    }));
}

export function warningLink(id) {
  return `${NINA}/meldungen/${encodeURIComponent(id)}`;
}

/** The full CAP text of one warning in `language`, else German. */
export async function warningDetail(id, language) {
  const alert = await (
    await get(`${NINA}/api31/warnings/${encodeURIComponent(id)}.json`)
  ).json();
  const infos = Array.isArray(alert?.info) ? alert.info : [];
  const lang = (code) => String(code ?? '').toLowerCase();
  return (
    infos.find((info) => lang(info.language).split('-')[0] === language) ??
    infos.find((info) => lang(info.language) === 'de') ??
    infos[0] ??
    null
  );
}
