import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const panels = [
  {
    kind: 'number',
    title: 'Ausgaben',
    value: 1234.5,
    unit: '€',
    tone: 'bad',
    note: 'vs. 1.100 € im September',
    query: {
      source: 'Girokonto',
      tools: [
        {
          name: 'hybridai__bank__list_transactions',
          args: { since: '2026-10-01' },
        },
      ],
      how: 'Summe aller Abbuchungen seit dem 1. Oktober',
    },
  },
  {
    kind: 'line',
    title: 'Pro Tag',
    unit: '€',
    series: [
      {
        name: 'Ausgaben',
        points: [
          { x: '2026-10-01', y: 12.3 },
          { x: '2026-10-02', y: 40 },
        ],
      },
    ],
    query: {
      source: 'Girokonto',
      tools: [{ name: 'hybridai__bank__list_transactions' }],
      how: 'Abbuchungen je Tag',
    },
  },
];

describe.sequential('container show_dashboard tool', () => {
  let workspaceRoot = '';

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (workspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = '';
    }
  });

  async function load() {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-dashboard-workspace-'),
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);
    return import('../container/src/tools.js');
  }

  test('writes the dashboard to one stable file and returns it with the dashboard media type', async () => {
    const { executeToolWithMetadata, TOOL_DEFINITIONS } = await load();
    expect(
      TOOL_DEFINITIONS.some(
        (definition) => definition.function.name === 'show_dashboard',
      ),
    ).toBe(true);

    const first = await executeToolWithMetadata(
      'show_dashboard',
      JSON.stringify({
        title: 'Geld im Oktober',
        subtitle: 'Girokonto',
        panels,
      }),
    );
    const parsed = JSON.parse(first.output) as {
      id: string;
      path: string;
      artifacts: Array<{ path: string; filename: string; mimeType: string }>;
    };
    expect(first.isError).toBe(false);
    expect(parsed.id).toBe('geld-im-oktober');
    expect(parsed.path).toBe('dashboards/geld-im-oktober.json');
    expect(parsed.artifacts).toEqual([
      {
        path: 'dashboards/geld-im-oktober.json',
        filename: 'Geld im Oktober.json',
        mimeType: 'application/vnd.hybridai.dashboard+json',
      },
    ]);
    const file = path.join(workspaceRoot, 'dashboards/geld-im-oktober.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(saved).toMatchObject({
      version: 1,
      id: 'geld-im-oktober',
      title: 'Geld im Oktober',
      panels: [
        { id: 'panel-1', kind: 'number', value: 1234.5, tone: 'bad' },
        { id: 'panel-2', kind: 'line' },
      ],
    });
    expect(Number.isNaN(Date.parse(saved.updatedAt))).toBe(false);

    // The same id replaces the file, even under a new title.
    await executeToolWithMetadata(
      'show_dashboard',
      JSON.stringify({
        id: 'geld-im-oktober',
        title: 'Geld im Oktober (neu)',
        panels: [{ ...panels[0], value: 1300 }],
      }),
    );
    expect(fs.readdirSync(path.join(workspaceRoot, 'dashboards'))).toEqual([
      'geld-im-oktober.json',
    ]);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).panels[0].value).toBe(
      1300,
    );
  });

  test('refuses figures given as text, panels without a query and ragged tables', async () => {
    const { executeToolWithMetadata } = await load();
    const call = async (panel: Record<string, unknown>) =>
      executeToolWithMetadata(
        'show_dashboard',
        JSON.stringify({ title: 'Test', panels: [panel] }),
      );

    const text = await call({ ...panels[0], value: 'ca. 1.200 €' });
    expect(text.isError).toBe(true);
    expect(text.output).toContain('panels[0].value');

    const { query: _query, ...withoutQuery } = panels[0];
    const unexplained = await call(withoutQuery);
    expect(unexplained.isError).toBe(true);
    expect(unexplained.output).toContain('panels[0].query');

    const ragged = await call({
      kind: 'table',
      title: 'Größte Posten',
      columns: ['Händler', 'Betrag'],
      rows: [['Bäckerei']],
      query: panels[0].query,
    });
    expect(ragged.isError).toBe(true);
    expect(ragged.output).toContain('one cell for each of the 2 columns');
    expect(fs.existsSync(path.join(workspaceRoot, 'dashboards'))).toBe(false);
  });

  test('keeps a refresh schedule beside the dashboards until it is changed', async () => {
    const { executeToolWithMetadata } = await load();
    const schedule = path.join(workspaceRoot, 'dashboards/.refresh.json');
    const call = (extra: Record<string, unknown>) =>
      executeToolWithMetadata(
        'show_dashboard',
        JSON.stringify({ title: 'Geld im Oktober', panels, ...extra }),
      );

    await call({ refresh: 'daily' });
    expect(JSON.parse(fs.readFileSync(schedule, 'utf-8'))).toEqual({
      'geld-im-oktober': 'daily',
    });
    // A refresh run leaves `refresh` out and keeps the schedule.
    await call({});
    expect(JSON.parse(fs.readFileSync(schedule, 'utf-8'))).toEqual({
      'geld-im-oktober': 'daily',
    });
    await call({ refresh: 'off' });
    expect(JSON.parse(fs.readFileSync(schedule, 'utf-8'))).toEqual({});
    expect((await call({ refresh: 'hourly' })).isError).toBe(true);
  });
});
