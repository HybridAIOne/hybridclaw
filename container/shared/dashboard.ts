/**
 * A dashboard: headline numbers, charts and tables from the user's own data,
 * each with the query behind it (the tools called, their arguments and in one
 * sentence what was counted). The `show_dashboard` tool checks one here and
 * writes it to `dashboards/<id>.json`; the gateway reads the same file to list
 * dashboards and to refresh one. The HybridAI app draws it natively, so the
 * format is data only: no HTML, no script.
 */

export const DASHBOARD_MIME_TYPE = 'application/vnd.hybridai.dashboard+json';
export const DASHBOARD_DIRECTORY = 'dashboards';
/** Which dashboards refresh by themselves, and when: `{ [id]: 'daily' | 'weekly' }`. */
export const DASHBOARD_SCHEDULE_FILE =
  `${DASHBOARD_DIRECTORY}/.refresh.json` as const;
/**
 * `daily`: every morning at 7 in the user's time zone; `weekly`: Monday
 * morning at 7. Each run is a model turn, so nothing more often.
 */
export type DashboardRefreshSchedule = 'daily' | 'weekly';
export const DASHBOARD_REFRESH_SCHEDULES: DashboardRefreshSchedule[] = [
  'daily',
  'weekly',
];
export const DASHBOARD_REFRESH_HOUR: number = 7;
export type DashboardSchedules = Record<string, DashboardRefreshSchedule>;

/** The tools a figure came from and, in one sentence, what was counted. */
export interface DashboardQuery {
  source: string;
  tools: Array<{ name: string; args?: Record<string, unknown> }>;
  how: string;
}

interface PanelBase {
  id: string;
  title: string;
  note?: string;
  query: DashboardQuery;
}

export interface NumberPanel extends PanelBase {
  kind: 'number';
  value: number;
  unit?: string;
  decimals?: number;
  tone?: 'good' | 'bad' | 'neutral';
}

export interface ChartPanel extends PanelBase {
  kind: 'line' | 'bar';
  unit?: string;
  series: Array<{ name: string; points: Array<{ x: string; y: number }> }>;
}

export interface TablePanel extends PanelBase {
  kind: 'table';
  columns: string[];
  rows: string[][];
}

export type DashboardPanel = NumberPanel | ChartPanel | TablePanel;

export interface Dashboard {
  version: 1;
  id: string;
  title: string;
  subtitle?: string;
  /** ISO time the figures were fetched. */
  updatedAt: string;
  panels: DashboardPanel[];
}

type PanelDraft = Pick<DashboardPanel, 'id' | 'kind' | 'title'> &
  Partial<
    Omit<NumberPanel, 'kind'> &
      Omit<ChartPanel, 'kind'> &
      Omit<TablePanel, 'kind'>
  >;

const TITLE_MAX = 80;
const SUBTITLE_MAX = 160;
const NOTE_MAX = 160;
const UNIT_MAX = 12;
const SOURCE_MAX = 60;
const HOW_MAX = 300;
const TOOL_NAME_MAX = 120;
const TOOL_ARGS_MAX = 2_000;
const TOOLS_MAX = 8;
const PANELS_MAX = 12;
const SERIES_MAX = 4;
const SERIES_NAME_MAX = 40;
const POINTS_MAX = 400;
const LABEL_MAX = 40;
const COLUMNS_MAX = 6;
const ROWS_MAX = 50;
const CELL_MAX = 120;
const KINDS = ['number', 'line', 'bar', 'table'];
const TONES: unknown[] = ['good', 'bad', 'neutral'];

/** `Geld im Oktober` → `geld-im-oktober`: the file name, stable across updates. */
export function dashboardId(text: unknown): string {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

export function dashboardFilePath(id: string): string {
  return `${DASHBOARD_DIRECTORY}/${id}.json`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(
  value: unknown,
  field: string,
  max: number,
  required: true,
): string;
function text(
  value: unknown,
  field: string,
  max: number,
  required: boolean,
): string | undefined;
function text(
  value: unknown,
  field: string,
  max: number,
  required: boolean,
): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`"${field}" is required.`);
    return undefined;
  }
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new Error(`"${field}" must be text.`);
  const result = String(value).trim().replace(/\s+/g, ' ');
  if (!result && required) throw new Error(`"${field}" is required.`);
  if (result.length > max)
    throw new Error(`"${field}" must be at most ${max} characters.`);
  return result || undefined;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(
      `"${field}" must be a number you computed from the data, such as 1234.5, never text.`,
    );
  return value;
}

function list(
  value: unknown,
  field: string,
  min: number,
  max: number,
): unknown[] {
  if (!Array.isArray(value)) throw new Error(`"${field}" must be a list.`);
  if (value.length < min)
    throw new Error(`"${field}" needs at least ${min} item(s).`);
  if (value.length > max)
    throw new Error(`"${field}" takes at most ${max} items.`);
  return value;
}

function query(value: unknown, field: string): DashboardQuery {
  if (!isObject(value))
    throw new Error(
      `"${field}" is required: the source, the tools you called with their arguments, and in "how" one sentence of what was counted.`,
    );
  const tools = list(value.tools ?? [], `${field}.tools`, 0, TOOLS_MAX).map(
    (tool, index) => {
      const where = `${field}.tools[${index}]`;
      if (!isObject(tool)) throw new Error(`"${where}" must be an object.`);
      const name = text(tool.name, `${where}.name`, TOOL_NAME_MAX, true);
      const args = tool.args ?? {};
      if (!isObject(args))
        throw new Error(`"${where}.args" must be an object.`);
      if (JSON.stringify(args).length > TOOL_ARGS_MAX)
        throw new Error(`"${where}.args" is too long.`);
      return Object.keys(args).length ? { name, args } : { name };
    },
  );
  return {
    source: text(value.source, `${field}.source`, SOURCE_MAX, true),
    tools,
    how: text(value.how, `${field}.how`, HOW_MAX, true),
  };
}

function series(value: unknown, field: string): ChartPanel['series'] {
  return list(value, field, 1, SERIES_MAX).map((item, index) => {
    const where = `${field}[${index}]`;
    if (!isObject(item)) throw new Error(`"${where}" must be an object.`);
    return {
      name: text(item.name, `${where}.name`, SERIES_NAME_MAX, true),
      points: list(item.points, `${where}.points`, 1, POINTS_MAX).map(
        (point, at) => {
          const spot = `${where}.points[${at}]`;
          if (!isObject(point)) throw new Error(`"${spot}" must be an object.`);
          return {
            x: text(point.x, `${spot}.x`, LABEL_MAX, true),
            y: finite(point.y, `${spot}.y`),
          };
        },
      ),
    };
  });
}

function table(
  panel: Record<string, unknown>,
  field: string,
): { columns: string[]; rows: string[][] } {
  const columns = list(panel.columns, `${field}.columns`, 1, COLUMNS_MAX).map(
    (column, index) =>
      text(column, `${field}.columns[${index}]`, LABEL_MAX, true),
  );
  const rows = list(panel.rows ?? [], `${field}.rows`, 0, ROWS_MAX).map(
    (row, index) => {
      const where = `${field}.rows[${index}]`;
      if (!Array.isArray(row) || row.length !== columns.length)
        throw new Error(
          `"${where}" must have one cell for each of the ${columns.length} columns.`,
        );
      return row.map(
        (cell, at) => text(cell, `${where}[${at}]`, CELL_MAX, false) ?? '',
      );
    },
  );
  return { columns, rows };
}

function panel(
  value: unknown,
  index: number,
  taken: Set<string>,
): DashboardPanel {
  const field = `panels[${index}]`;
  if (!isObject(value)) throw new Error(`"${field}" must be an object.`);
  const kind = value.kind as DashboardPanel['kind'];
  if (!KINDS.includes(kind))
    throw new Error(`"${field}.kind" must be one of ${KINDS.join(', ')}.`);
  let id = dashboardId(value.id) || `panel-${index + 1}`;
  while (taken.has(id)) id = `${id}-${index + 1}`;
  taken.add(id);
  const result: PanelDraft = {
    id,
    kind,
    title: text(value.title, `${field}.title`, TITLE_MAX, true),
  };
  const note = text(value.note, `${field}.note`, NOTE_MAX, false);
  if (note) result.note = note;
  const unit = text(value.unit, `${field}.unit`, UNIT_MAX, false);
  if (kind === 'number') {
    result.value = finite(value.value, `${field}.value`);
    if (unit) result.unit = unit;
    if (value.decimals !== undefined) {
      if (
        typeof value.decimals !== 'number' ||
        !Number.isInteger(value.decimals) ||
        value.decimals < 0 ||
        value.decimals > 4
      )
        throw new Error(`"${field}.decimals" must be a whole number 0 to 4.`);
      result.decimals = value.decimals;
    }
    if (value.tone !== undefined) {
      if (!TONES.includes(value.tone))
        throw new Error(`"${field}.tone" must be one of ${TONES.join(', ')}.`);
      result.tone = value.tone as NumberPanel['tone'];
    }
  } else if (kind === 'table') {
    Object.assign(result, table(value, field));
  } else {
    if (unit) result.unit = unit;
    result.series = series(value.series, `${field}.series`);
  }
  result.query = query(value.query, `${field}.query`);
  return result as DashboardPanel;
}

/**
 * Checks the tool's arguments. `updatedAt` is when the tool ran: every figure
 * in one dashboard comes from the same turn, so one time covers them all.
 */
export function normalizeDashboard(
  args: unknown,
  now: Date = new Date(),
):
  | { dashboard: Dashboard; error?: undefined }
  | { error: string; dashboard?: undefined } {
  try {
    if (!isObject(args)) throw new Error('Give the dashboard as an object.');
    const title = text(args.title, 'title', TITLE_MAX, true);
    const id = dashboardId(args.id) || dashboardId(title) || 'dashboard';
    const taken = new Set<string>();
    const panels = list(args.panels, 'panels', 1, PANELS_MAX).map(
      (value, index) => panel(value, index, taken),
    );
    const dashboard: Pick<Dashboard, 'version' | 'id' | 'title'> &
      Partial<Dashboard> = { version: 1, id, title };
    const subtitle = text(args.subtitle, 'subtitle', SUBTITLE_MAX, false);
    if (subtitle) dashboard.subtitle = subtitle;
    dashboard.updatedAt = now.toISOString();
    dashboard.panels = panels;
    return { dashboard: dashboard as Dashboard };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The schedule file's contents, keeping only known ids and schedules. */
export function readDashboardSchedules(text: string): DashboardSchedules {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  const schedules: DashboardSchedules = {};
  if (!isObject(raw)) return schedules;
  for (const [id, every] of Object.entries(raw) as [
    string,
    DashboardRefreshSchedule,
  ][]) {
    if (dashboardId(id) === id && DASHBOARD_REFRESH_SCHEDULES.includes(every))
      schedules[id] = every;
  }
  return schedules;
}

/**
 * `refresh` as the tool or a command gives it: a schedule, `off`, or nothing
 * to keep what there is. Throws on anything else.
 */
export function dashboardRefresh(
  value: unknown,
): DashboardRefreshSchedule | 'off' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (
    value === 'off' ||
    DASHBOARD_REFRESH_SCHEDULES.includes(value as DashboardRefreshSchedule)
  )
    return value as DashboardRefreshSchedule | 'off';
  throw new Error(
    `"refresh" must be one of ${[...DASHBOARD_REFRESH_SCHEDULES, 'off'].join(', ')}.`,
  );
}

/** The schedules with one dashboard's set to `refresh` (`off` removes it). */
export function withDashboardRefresh(
  schedules: DashboardSchedules,
  id: string,
  refresh: DashboardRefreshSchedule | 'off' | undefined,
): DashboardSchedules {
  const next = { ...schedules };
  if (refresh === 'off') delete next[id];
  else if (refresh) next[id] = refresh;
  return next;
}

/** Every tool a dashboard's queries name, once each, in order. */
export function dashboardQueryTools(dashboard: Dashboard): string[] {
  const names: string[] = [];
  for (const item of dashboard.panels) {
    for (const tool of item.query.tools) {
      if (!names.includes(tool.name)) names.push(tool.name);
    }
  }
  return names;
}
