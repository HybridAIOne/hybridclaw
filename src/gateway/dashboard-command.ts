/**
 * `/dashboard` — the dashboards the agent made with `show_dashboard`, kept as
 * `dashboards/<id>.json` in its workspace. `list` and `show` read them;
 * `refresh` has the agent call each figure's query tools again in a run of its
 * own and write the dashboard anew. That run may only call the read tools the
 * queries name, plus `show_dashboard`, and it is never part of a chat.
 * Companion apps use `--json`, answered in one line that survives a chat relay
 * (`chatSafeJson`); a refresh answers at once and the app asks `show` until
 * it is done.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  DASHBOARD_DIRECTORY,
  type Dashboard,
  dashboardFilePath,
  dashboardId,
  dashboardQueryTools,
  normalizeDashboard,
} from '../../container/shared/dashboard.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { logger } from '../logger.js';
import { SHOW_DASHBOARD_TOOL } from './app-widgets.js';
import { badCommand, plainCommand } from './gateway-command-results.js';
import type {
  GatewayCommandRequest,
  GatewayCommandResult,
} from './gateway-types.js';
import { chatSafeJson } from './schedule-command.js';

const USAGE =
  'Usage: `/dashboard list` lists your dashboards, `/dashboard show <id>` shows one, `/dashboard refresh <id>` fetches its figures again. Add `--json` for a machine-readable answer.';

// Tools a refresh may call when a query names them: they only read.
const LOCAL_READ_TOOLS = new Set([
  'device_data',
  'glob',
  'grep',
  'read',
  'session_search',
  'web_fetch',
  'web_search',
]);
// The verb a read-only connector tool starts with, as for live apps.
const CONNECTOR_READ_VERBS = new Set([
  'describe',
  'fetch',
  'find',
  'get',
  'list',
  'lookup',
  'query',
  'read',
  'retrieve',
  'search',
]);

export function isDashboardReadTool(name: string): boolean {
  if (LOCAL_READ_TOOLS.has(name)) return true;
  if (!name.includes('__')) return false;
  const action = name.split('__').at(-1)?.toLowerCase() ?? '';
  const [verb] = action.split(/[_-]/);
  return Boolean(verb && CONNECTOR_READ_VERBS.has(verb));
}

export interface DashboardRefreshRun {
  agentId: string;
  dashboard: Dashboard;
  allowedTools: string[];
  prompt: string;
}

/** Runs the agent once; resolves with an error text when it did not finish. */
export type DashboardRefreshRunner = (
  run: DashboardRefreshRun,
) => Promise<{ error?: string }>;

interface RefreshState {
  running: boolean;
  error?: string;
}

// Per agent and dashboard; a gateway restart forgets a refresh, and the app
// then sees the old figures with no refresh running.
const refreshes = new Map<string, RefreshState>();

function readDashboard(agentId: string, id: string): Dashboard | null {
  const file = path.join(agentWorkspaceDir(agentId), dashboardFilePath(id));
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
  const record = raw as { updatedAt?: unknown } | null;
  const updatedAt =
    typeof record?.updatedAt === 'string' ? new Date(record.updatedAt) : null;
  const checked = normalizeDashboard(
    raw,
    updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : undefined,
  );
  return checked.dashboard ?? null;
}

function listDashboards(agentId: string): Dashboard[] {
  const directory = path.join(agentWorkspaceDir(agentId), DASHBOARD_DIRECTORY);
  let names: string[] = [];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => readDashboard(agentId, name.slice(0, -'.json'.length)))
    .filter((dashboard): dashboard is Dashboard => dashboard !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function dashboardRefreshPrompt(
  dashboard: Dashboard,
  allowedTools: string[],
  now: Date,
): string {
  return [
    `Refresh the dashboard "${dashboard.title}" with current data. It is ${now.toISOString()} now.`,
    "For each panel, call the tools in its query again with the same arguments; move a date forward only when the panel's `how` names a period that moves with time, such as the last 30 days. Compute each figure exactly as its `how` says.",
    `Then call \`${SHOW_DASHBOARD_TOOL}\` once with id "${dashboard.id}" and the same title, subtitle, panels, kinds, queries and order, with the new figures. When a panel's tools fail or are not among yours, keep that panel as it is.`,
    `Your tools: ${allowedTools.join(', ')}. Write no reply.`,
    '',
    'The dashboard now:',
    JSON.stringify(dashboard),
  ].join('\n');
}

function startRefresh(
  agentId: string,
  dashboard: Dashboard,
  runner: DashboardRefreshRunner,
): string | null {
  const key = `${agentId}:${dashboard.id}`;
  if (refreshes.get(key)?.running) return null;
  const readTools = dashboardQueryTools(dashboard).filter(isDashboardReadTool);
  if (readTools.length === 0) {
    return 'Its figures come from no tool a refresh may call again. Ask in the chat to update it.';
  }
  const allowedTools = [...readTools, SHOW_DASHBOARD_TOOL];
  const startedAt = new Date();
  refreshes.set(key, { running: true });
  void runner({
    agentId,
    dashboard,
    allowedTools,
    prompt: dashboardRefreshPrompt(dashboard, allowedTools, startedAt),
  })
    .then((outcome) => {
      const after = readDashboard(agentId, dashboard.id);
      const written =
        after !== null && new Date(after.updatedAt) >= startedAt
          ? undefined
          : (outcome.error ?? 'The figures could not be fetched again.');
      refreshes.set(key, { running: false, error: written });
    })
    .catch((error: unknown) => {
      logger.warn(
        { agentId, dashboard: dashboard.id, error },
        'Dashboard refresh failed',
      );
      refreshes.set(key, {
        running: false,
        error: 'The figures could not be fetched again.',
      });
    });
  return null;
}

function summary(dashboard: Dashboard, state: RefreshState | undefined) {
  return {
    id: dashboard.id,
    title: dashboard.title,
    ...(dashboard.subtitle ? { subtitle: dashboard.subtitle } : {}),
    updatedAt: dashboard.updatedAt,
    panels: dashboard.panels.length,
    refreshing: state?.running ?? false,
  };
}

function show(
  agentId: string,
  dashboard: Dashboard,
  json: boolean,
): GatewayCommandResult {
  const state = refreshes.get(`${agentId}:${dashboard.id}`);
  if (json) {
    return plainCommand(
      chatSafeJson({
        version: 1,
        dashboard,
        refreshing: state?.running ?? false,
        ...(state?.error ? { error: state.error } : {}),
      }),
    );
  }
  const lines = [
    `**${dashboard.title}**${dashboard.subtitle ? ` · ${dashboard.subtitle}` : ''}`,
    `Updated ${dashboard.updatedAt}${state?.running ? ' · refreshing' : ''}`,
    ...dashboard.panels.map((panel) =>
      panel.kind === 'number'
        ? `- ${panel.title}: ${panel.value}${panel.unit ? ` ${panel.unit}` : ''}`
        : `- ${panel.title} (${panel.kind})`,
    ),
    ...(state?.error ? ['', `Last refresh failed: ${state.error}`] : []),
  ];
  return plainCommand(lines.join('\n'));
}

export function handleDashboardCommand(
  req: GatewayCommandRequest,
  agentId: string,
  runner: DashboardRefreshRunner,
): GatewayCommandResult {
  const rest = req.args.slice(1).map(String);
  const json = rest.includes('--json');
  const [sub = 'list', ...operands] = rest.filter((arg) => arg !== '--json');
  const action = sub.toLowerCase();

  if (action === 'list' && operands.length === 0) {
    const dashboards = listDashboards(agentId);
    if (json) {
      return plainCommand(
        chatSafeJson({
          version: 1,
          dashboards: dashboards.map((dashboard) =>
            summary(dashboard, refreshes.get(`${agentId}:${dashboard.id}`)),
          ),
        }),
      );
    }
    if (dashboards.length === 0) {
      return plainCommand(
        'No dashboards yet. Ask for one, such as "a dashboard of my spending this month".',
      );
    }
    return plainCommand(
      dashboards
        .map((dashboard) => `- \`${dashboard.id}\` ${dashboard.title}`)
        .join('\n'),
    );
  }

  if ((action === 'show' || action === 'refresh') && operands.length === 1) {
    const id = dashboardId(operands[0]);
    const dashboard = id ? readDashboard(agentId, id) : null;
    if (!dashboard) {
      return badCommand('Dashboard', `No dashboard \`${operands[0]}\`.`);
    }
    if (action === 'refresh') {
      const refused = startRefresh(agentId, dashboard, runner);
      if (refused) return badCommand('Dashboard', refused);
    }
    return show(agentId, dashboard, json);
  }

  return badCommand('Usage', USAGE);
}
