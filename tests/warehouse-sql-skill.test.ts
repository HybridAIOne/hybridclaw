import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';

const helperPath = path.join(
  process.cwd(),
  'skills',
  'warehouse-sql',
  'scripts',
  'warehouse_sql.py',
);
const fixturePath = path.join(
  process.cwd(),
  'skills',
  'warehouse-sql',
  'evals',
  'tpch_tiny.sql',
);
const backendStubPath = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'warehouse_backend_stub.py',
);

function runHelper(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('python3', [helperPath, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

function runHelperAsync(args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn('python3', [helperPath, ...args], {
        env: { ...process.env, ...env },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('close', (status) => {
        resolve({ status, stdout, stderr });
      });
    },
  );
}

function createFixtureDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-sql-test-'));
  const dbPath = path.join(dir, 'tpch.db');
  const db = new Database(dbPath);
  try {
    db.exec(fs.readFileSync(fixturePath, 'utf-8'));
  } finally {
    db.close();
  }
  return dbPath;
}

test('warehouse SQL helper --help exits cleanly', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Natural-language warehouse SQL');
  expect(result.stdout).toContain('schema');
  expect(result.stdout).toContain('review');
  expect(result.stdout).toContain('query');
  expect(result.stdout).toContain('eval-scenarios');
});

test('warehouse SQL helper plans and reviews read-only SQL', () => {
  const result = runHelper([
    '--format',
    'json',
    'plan',
    'top customers by revenue',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.command).toBe('plan');
  expect(payload.sql).toContain('JOIN lineitem');
  expect(payload.sql).toContain('revenue');
  expect(payload.review.status).toBe('pass');
  expect(payload.review.readOnly).toBe(true);
  expect(payload.review.modelReview.required).toBe(true);
});

test('warehouse SQL helper caches SQLite schema introspection', () => {
  const dbPath = createFixtureDb();
  const cacheDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'warehouse-sql-cache-'),
  );

  const first = runHelper([
    '--format',
    'json',
    'schema',
    '--backend',
    'sqlite',
    '--database',
    dbPath,
    '--cache-dir',
    cacheDir,
  ]);
  expect(first.status).toBe(0);
  const firstPayload = JSON.parse(first.stdout);
  expect(firstPayload.cache.status).toBe('miss');
  expect(
    firstPayload.tables.map((table: { name: string }) => table.name),
  ).toContain('lineitem');

  const second = runHelper([
    '--format',
    'json',
    'schema',
    '--backend',
    'sqlite',
    '--database',
    dbPath,
    '--cache-dir',
    cacheDir,
  ]);
  expect(second.status).toBe(0);
  const secondPayload = JSON.parse(second.stdout);
  expect(secondPayload.cache.status).toBe('hit');
  expect(secondPayload.cache.path).toBe(firstPayload.cache.path);
});

test('warehouse SQL helper refreshes and executes non-SQLite backends through connector commands', () => {
  const cacheDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'warehouse-sql-cache-'),
  );
  const backendCommand = `python3 ${backendStubPath}`;

  const schema = runHelper([
    '--format',
    'json',
    'schema',
    '--backend',
    'postgres',
    '--profile',
    'analytics',
    '--backend-command',
    backendCommand,
    '--cache-dir',
    cacheDir,
    '--refresh',
  ]);
  expect(schema.status).toBe(0);
  const schemaPayload = JSON.parse(schema.stdout);
  expect(schemaPayload.backend).toBe('postgres');
  expect(schemaPayload.adapter).toBe('command');
  expect(schemaPayload.tables).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'customer',
        schema: 'public',
        columns: expect.arrayContaining([
          expect.objectContaining({ name: 'c_name', type: 'text' }),
        ]),
      }),
      expect.objectContaining({
        name: 'orders',
        foreignKeys: [
          {
            columns: ['o_custkey'],
            referencesColumns: ['c_custkey'],
            referencesTable: 'customer',
          },
        ],
      }),
    ]),
  );

  const query = runHelper([
    '--format',
    'json',
    'query',
    '--backend',
    'postgres',
    '--profile',
    'analytics',
    '--backend-command',
    backendCommand,
    '--execute',
    'SELECT c_name FROM customer LIMIT 1',
  ]);
  expect(query.status).toBe(0);
  const queryPayload = JSON.parse(query.stdout);
  expect(queryPayload.execution.status).toBe('ran');
  expect(queryPayload.execution.backend).toBe('postgres');
  expect(queryPayload.execution.rows).toEqual([
    { c_name: 'Customer#000000101', revenue: 1650 },
  ]);
});

test('warehouse SQL helper blocks writes unless the per-skill grant matches', () => {
  const blocked = runHelper([
    '--format',
    'json',
    'review',
    "UPDATE customer SET c_name = 'x'",
  ]);
  expect(blocked.status).toBe(0);
  const blockedPayload = JSON.parse(blocked.stdout);
  expect(blockedPayload.review.status).toBe('block');
  expect(blockedPayload.review.requiresWriteGrant).toBe(true);
  expect(blockedPayload.review.findings).toEqual(
    expect.arrayContaining([
      expect.stringContaining('Mutating or privileged keyword'),
      expect.stringContaining('--allow-write'),
    ]),
  );

  const allowed = runHelper(
    [
      '--format',
      'json',
      'review',
      '--allow-write',
      '--write-grant',
      'test-grant',
      "UPDATE customer SET c_name = 'x'",
    ],
    { HYBRIDCLAW_WAREHOUSE_SQL_WRITE_GRANT: 'test-grant' },
  );
  expect(allowed.status).toBe(0);
  const allowedPayload = JSON.parse(allowed.stdout);
  expect(allowedPayload.review.status).toBe('pass');
  expect(allowedPayload.review.readOnly).toBe(false);
});

test('warehouse SQL helper honors write grants during SQLite execution', () => {
  const dbPath = createFixtureDb();
  const result = runHelper(
    [
      '--format',
      'json',
      'query',
      '--backend',
      'sqlite',
      '--database',
      dbPath,
      '--execute',
      '--allow-write',
      '--write-grant',
      'test-grant',
      "UPDATE customer SET c_name = 'Updated Customer' WHERE c_custkey = 101",
    ],
    { HYBRIDCLAW_WAREHOUSE_SQL_WRITE_GRANT: 'test-grant' },
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.execution.status).toBe('ran');
  expect(payload.execution.affectedRows).toBe(1);

  const db = new Database(dbPath);
  try {
    expect(
      db
        .prepare('SELECT c_name FROM customer WHERE c_custkey = 101')
        .pluck()
        .get(),
    ).toBe('Updated Customer');
  } finally {
    db.close();
  }
});

test('warehouse SQL helper executes reviewed SQLite queries only when requested', () => {
  const dbPath = createFixtureDb();

  const reviewOnly = runHelper([
    '--format',
    'json',
    'query',
    '--backend',
    'sqlite',
    '--database',
    dbPath,
    'SELECT c_name FROM customer ORDER BY c_name LIMIT 1',
  ]);
  expect(reviewOnly.status).toBe(0);
  const reviewPayload = JSON.parse(reviewOnly.stdout);
  expect(reviewPayload.execution.status).toBe('not-run');

  const executed = runHelper([
    '--format',
    'json',
    'query',
    '--backend',
    'sqlite',
    '--database',
    dbPath,
    '--execute',
    'SELECT c_name FROM customer ORDER BY c_name LIMIT 1',
  ]);
  expect(executed.status).toBe(0);
  const executedPayload = JSON.parse(executed.stdout);
  expect(executedPayload.execution.status).toBe('ran');
  expect(executedPayload.execution.rows).toEqual([
    { c_name: 'Customer#000000101' },
  ]);
});

test('warehouse SQL helper eval suite covers TPC-H-style scenarios', () => {
  const result = runHelper(['--format', 'json', 'eval-scenarios']);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.dataset).toBe('TPC-H-style tiny fixture');
  expect(payload.scenarioCount).toBe(12);
  expect(payload.failed).toBe(0);
  expect(payload.categories).toMatchObject({
    customers: 1,
    operations: 1,
    orders: 4,
    parts: 1,
    pricing: 1,
    revenue: 3,
    supplier: 1,
  });
});

test('warehouse SQL helper emits backend contracts and schedule refresh commands', () => {
  const contract = runHelper([
    '--format',
    'json',
    'backend-contract',
    '--backend',
    'postgres',
  ]);
  expect(contract.status).toBe(0);
  const contractPayload = JSON.parse(contract.stdout);
  expect(contractPayload.execution).toContain('operator-approved');
  expect(contractPayload.introspection.tables).toContain(
    'information_schema.tables',
  );

  const schedule = runHelper([
    '--format',
    'json',
    'schedule-command',
    '--backend',
    'postgres',
    '--profile',
    'analytics',
    '--every',
    '0 */6 * * *',
  ]);
  expect(schedule.status).toBe(0);
  const schedulePayload = JSON.parse(schedule.stdout);
  expect(schedulePayload.command).toContain('--refresh');
  expect(schedulePayload.hybridclawExample).toContain(
    'hybridclaw schedule create',
  );
});

test('warehouse SQL helper registers scheduled schema refresh jobs through the gateway admin API', async () => {
  const received = await new Promise<{
    body: string;
    authorization: string | undefined;
    url: string | undefined;
  }>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jobs: [] }));
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({
            body,
            authorization: req.headers.authorization,
            url: req.url,
          });
        });
      });
    });
    server.listen(0, '127.0.0.1', async () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Expected TCP test server address.'));
        return;
      }
      const result = await runHelperAsync([
        '--format',
        'json',
        'schedule-refresh',
        '--backend',
        'postgres',
        '--profile',
        'analytics',
        '--backend-command',
        `python3 ${backendStubPath}`,
        '--every',
        '0 */6 * * *',
        '--gateway-url',
        `http://127.0.0.1:${address.port}`,
        '--gateway-token',
        'test-token',
      ]);
      if (result.status !== 0) {
        reject(new Error(result.stderr || result.stdout));
      }
    });
  });

  expect(received.url).toBe('/api/admin/scheduler');
  expect(received.authorization).toBe('Bearer test-token');
  const payload = JSON.parse(received.body);
  expect(payload.job).toEqual(
    expect.objectContaining({
      id: 'warehouse-sql-schema-postgres-analytics',
      enabled: true,
      schedule: expect.objectContaining({
        kind: 'cron',
        expr: '0 */6 * * *',
      }),
      action: expect.objectContaining({
        kind: 'agent_turn',
        message: expect.stringContaining('--refresh'),
      }),
    }),
  );
});
