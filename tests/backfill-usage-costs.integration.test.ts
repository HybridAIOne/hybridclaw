import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { useTempDir } from './test-utils.js';

const REPO = path.resolve(import.meta.dirname, '..');
const run = promisify(execFile);
const makeTempDir = useTempDir('hc-backfill-costs-');

test('the source maintenance script runs without nested dist modules and defaults to dry-run', async () => {
  const root = makeTempDir();
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  const dbPath = path.join(data, 'usage.db');
  const database = new Database(dbPath);
  try {
    database.exec(`CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY, model TEXT, input_tokens INTEGER,
      output_tokens INTEGER, cost_usd REAL
    )`);
    database
      .prepare('INSERT INTO usage_events VALUES (?, ?, ?, ?, ?)')
      .run(1, 'hybridai/gpt-priced', 100, 50, 0);
  } finally {
    database.close();
  }
  // A priced row the script could update, so dry-run must be what holds it back.
  const catalog = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        data: [
          {
            id: 'gpt-priced',
            pricing: { prompt: '0.000002', completion: '0.00001' },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) =>
    catalog.listen(0, '127.0.0.1', resolve),
  );
  const { port } = catalog.address() as AddressInfo;
  fs.writeFileSync(
    path.join(data, 'config.json'),
    JSON.stringify({
      ops: { dbPath },
      hybridai: { baseUrl: `http://127.0.0.1:${port}` },
    }),
  );
  let stdout: string;
  try {
    ({ stdout } = await run(
      process.execPath,
      [path.join(REPO, 'scripts/backfill-usage-costs.mjs')],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: root,
          HYBRIDCLAW_DATA_DIR: data,
          HYBRIDCLAW_DISABLE_CONFIG_WATCHER: '1',
          HYBRIDAI_API_KEY: 'test-key',
        },
        timeout: 15_000,
      },
    ));
  } finally {
    catalog.close();
  }
  const jsonStart = stdout.indexOf('{');
  expect(jsonStart).toBeGreaterThanOrEqual(0);
  expect(JSON.parse(stdout.slice(jsonStart))).toMatchObject({
    mode: 'dry-run',
    candidateRows: 1,
    updatableRows: 1,
  });
  const result = new Database(dbPath, { readonly: true });
  try {
    expect(
      result.prepare('SELECT cost_usd FROM usage_events WHERE id = 1').get(),
    ).toEqual({ cost_usd: 0 });
    expect(
      fs.readdirSync(data).some((name) => name.includes('usage-cost-backfill')),
    ).toBe(false);
  } finally {
    result.close();
  }
}, 30_000);
