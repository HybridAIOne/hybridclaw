export declare const DASHBOARD_MIME_TYPE =
  'application/vnd.hybridai.dashboard+json';
export declare const DASHBOARD_DIRECTORY = 'dashboards';
export declare const DASHBOARD_SCHEDULE_FILE = 'dashboards/.refresh.json';
export type DashboardRefreshSchedule = 'daily' | 'weekly';
export declare const DASHBOARD_REFRESH_SCHEDULES: DashboardRefreshSchedule[];
export declare const DASHBOARD_REFRESH_HOUR: number;
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

export declare function dashboardId(text: unknown): string;
export declare function dashboardFilePath(id: string): string;
export declare function normalizeDashboard(
  args: unknown,
  now?: Date,
):
  | { dashboard: Dashboard; error?: undefined }
  | { error: string; dashboard?: undefined };
export declare function dashboardQueryTools(dashboard: Dashboard): string[];
export declare function readDashboardSchedules(
  text: string,
): DashboardSchedules;
export declare function dashboardRefresh(
  value: unknown,
): DashboardRefreshSchedule | 'off' | undefined;
export declare function withDashboardRefresh(
  schedules: DashboardSchedules,
  id: string,
  refresh: DashboardRefreshSchedule | 'off' | undefined,
): DashboardSchedules;
