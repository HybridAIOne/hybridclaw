import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';

import { getAgentById, initDatabase, upsertAgent } from '../src/memory/db.js';

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

test('persists agent routing and budget policy together', () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-routing-db-'));
  initDatabase({ quiet: true, dbPath: path.join(tempDir, 'hybridclaw.db') });

  upsertAgent({
    id: 'planner',
    budget: { cap: 20, currency: 'EUR', unit: 'EUR' },
    routing: {
      start: 'general',
      max: 'advanced',
      sovereignty: 'region',
      target: { quality: 0.8, speed: 0.4 },
    },
  });

  expect(getAgentById('planner')).toMatchObject({
    budget: { cap: 20, currency: 'EUR', unit: 'EUR' },
    routing: {
      start: 'general',
      max: 'advanced',
      sovereignty: 'region',
      target: { quality: 0.8, speed: 0.4 },
    },
  });
});
