import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import { closeDatabase, initDatabase } from '../src/memory/db.js';
import { getAllJobs } from '../src/memory/jobs.js';
import { useTempDir } from './test-utils.js';

const temp = useTempDir('hy-legacy-tasks-');
afterEach(closeDatabase);

test.each([69, 70])(
  'deleted legacy tasks stay deleted when upgrading schema v%i',
  (version) => {
    const dbPath = path.join(temp(), 'test.db');
    initDatabase({ quiet: true, dbPath });

    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        cron_expr TEXT NOT NULL,
        run_at TEXT,
        every_ms INTEGER,
        prompt TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        last_run TEXT,
        last_status TEXT,
        consecutive_errors INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO tasks (session_id, channel_id, cron_expr, every_ms, prompt)
        VALUES ('s1', 'web', '', 1800000, 'ping');
    `);
    if (version === 69) {
      legacy.exec('DROP TABLE work_records');
    } else {
      legacy.exec(
        "INSERT INTO work_records (id, agent_id, session_id, data) VALUES ('work-1', 'main', 's1', '{}')",
      );
    }
    legacy.pragma(`user_version = ${version}`);
    legacy.close();

    initDatabase({ quiet: true, dbPath });

    const inspect = new Database(dbPath, { readonly: true });
    const jobs = inspect
      .prepare("SELECT id FROM jobs WHERE kind = 'scheduled_task'")
      .all();
    const tasksTable = inspect
      .prepare("SELECT name FROM sqlite_master WHERE name = 'tasks'")
      .get();
    expect(inspect.pragma('user_version', { simple: true })).toBe(71);
    expect(inspect.prepare('SELECT id FROM work_records').all()).toEqual(
      version === 69 ? [] : [{ id: 'work-1' }],
    );
    inspect.close();

    initDatabase({ quiet: true, dbPath });
    expect(getAllJobs({ kind: 'scheduled_task' })).toEqual([]);

    expect(jobs).toEqual([]);
    expect(tasksTable).toBeUndefined();
  },
);
