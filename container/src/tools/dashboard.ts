/**
 * `show_dashboard`: headline numbers, charts and tables from the user's own
 * data, each with the query behind it. The HybridAI app shows the dashboard as
 * a card under the reply and keeps it in the Library, where the user taps a
 * figure to see how it was counted and refreshes it. The tool only writes one
 * JSON file, `dashboards/<id>.json`, and returns it as an artifact with its
 * own media type. Calling it again with the same id replaces that file, so a
 * dashboard keeps one place and every card showing it shows the newest
 * figures.
 */
import {
  DASHBOARD_MIME_TYPE,
  DASHBOARD_SCHEDULE_FILE,
  dashboardFilePath,
  dashboardRefresh,
  normalizeDashboard,
  readDashboardSchedules,
  withDashboardRefresh,
} from '../../shared/dashboard.js';
import type { ToolDefinition } from '../types.js';

export const SHOW_DASHBOARD_TOOL = 'show_dashboard';

export function runShowDashboard(
  args: Record<string, unknown>,
  writeFile: (relativePath: string, contents: string) => void,
  readFile: (relativePath: string) => string,
  now = new Date(),
): string {
  const refresh = dashboardRefresh(args.refresh);
  const checked = normalizeDashboard(args, now);
  if (checked.error !== undefined) throw new Error(checked.error);
  const { dashboard } = checked;
  const relativePath = dashboardFilePath(dashboard.id);
  writeFile(relativePath, `${JSON.stringify(dashboard, null, 2)}\n`);
  // The schedule lives beside the dashboards, so a refresh that leaves
  // `refresh` out keeps it.
  if (refresh) {
    const schedules = withDashboardRefresh(
      readDashboardSchedules(readFile(DASHBOARD_SCHEDULE_FILE)),
      dashboard.id,
      refresh,
    );
    writeFile(
      DASHBOARD_SCHEDULE_FILE,
      `${JSON.stringify(schedules, null, 2)}\n`,
    );
  }
  return JSON.stringify({
    success: true,
    id: dashboard.id,
    path: relativePath,
    note: 'The app shows this dashboard as a card under your reply and keeps it in the Library; tapping a figure shows its query. Say in two or three sentences what stands out, with the numbers. Do not repeat every figure or link the file.',
    artifacts: [
      {
        path: relativePath,
        filename: `${dashboard.title}.json`,
        mimeType: DASHBOARD_MIME_TYPE,
      },
    ],
  });
}

const QUERY_SCHEMA = {
  type: 'object',
  description:
    'How this figure was made, shown when the user taps it. Required on every panel.',
  properties: {
    source: {
      type: 'string',
      description:
        'Where the data lives, as the user knows it: `Gmail`, `Google Calendar`, `Sparkasse`, `iPhone Health`.',
    },
    tools: {
      type: 'array',
      description:
        'The tools you called for this figure, with the exact arguments. A refresh calls them again.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          args: { type: 'object' },
        },
        required: ['name'],
      },
    },
    how: {
      type: 'string',
      description:
        "One sentence in the user's language of what was counted, such as `Sum of all card payments since 1 October, refunds subtracted`.",
    },
  },
  required: ['source', 'tools', 'how'],
};

export const SHOW_DASHBOARD_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: SHOW_DASHBOARD_TOOL,
    description:
      "Show a dashboard of the user's own figures: headline numbers, line and bar charts, and short tables, each with the query behind it. Use it when the user asks for a dashboard, an overview of numbers, or to follow or compare figures over time from their mail, calendar, bank, health or other connected data. Fetch the data with your tools first and compute every figure from what they returned; never estimate. To change or refresh a dashboard, call it again with the same `id` and the whole dashboard.",
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description:
            'Leave out for a new dashboard; give the `id` a previous call returned to replace that dashboard.',
        },
        title: {
          type: 'string',
          description:
            "A short name in the user's language, such as `Geld im Oktober`.",
        },
        subtitle: {
          type: 'string',
          description:
            'The scope in a few words, such as `Girokonto · 1.–9. Oktober`.',
        },
        refresh: {
          type: 'string',
          enum: ['daily', 'weekly', 'off'],
          description:
            "Only when the user asks to keep it current: `daily` fetches the figures every morning at 7, `weekly` on Monday mornings, in the user's time zone; `off` stops that. Leave out to keep the dashboard's schedule.",
        },
        panels: {
          type: 'array',
          description:
            'Two to four `number` panels for the headline figures first, then charts and tables. At most 12.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              kind: {
                type: 'string',
                enum: ['number', 'line', 'bar', 'table'],
              },
              title: { type: 'string' },
              note: {
                type: 'string',
                description:
                  'One line of context under the figure, such as `vs. 1.100 € im September`.',
              },
              value: {
                type: 'number',
                description: 'For `number`: the figure as a plain number.',
              },
              unit: {
                type: 'string',
                description: 'Such as `€`, `%`, `h`, `Schritte`.',
              },
              decimals: {
                type: 'integer',
                description: 'For `number`: digits after the point, 0 to 4.',
              },
              tone: {
                type: 'string',
                enum: ['good', 'bad', 'neutral'],
                description:
                  'For `number`: whether the figure is good or bad news for the user; leave out when neither.',
              },
              series: {
                type: 'array',
                description:
                  'For `line` and `bar`: up to 4 series. `x` is a label or an ISO date (`2026-10-09`); `y` a number.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    points: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          x: { type: 'string' },
                          y: { type: 'number' },
                        },
                        required: ['x', 'y'],
                      },
                    },
                  },
                  required: ['name', 'points'],
                },
              },
              columns: {
                type: 'array',
                items: { type: 'string' },
                description: 'For `table`: up to 6 column names.',
              },
              rows: {
                type: 'array',
                items: { type: 'array', items: { type: 'string' } },
                description:
                  'For `table`: up to 50 rows, one cell per column, written as they should read.',
              },
              query: QUERY_SCHEMA,
            },
            required: ['kind', 'title', 'query'],
          },
        },
      },
      required: ['title', 'panels'],
    },
  },
};
