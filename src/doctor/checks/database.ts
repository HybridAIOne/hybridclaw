import fs from 'node:fs';
import Database from 'better-sqlite3';
import { DB_PATH } from '../../config/config.js';
import { DATABASE_SCHEMA_VERSION, initDatabase } from '../../memory/db.js';
import type { DiagResult } from '../types.js';
import { formatBytes, makeResult, shortenHomePath } from '../utils.js';

export async function checkDatabase(): Promise<DiagResult[]> {
  const dbPath = DB_PATH;
  const displayPath = shortenHomePath(dbPath);

  if (!fs.existsSync(dbPath)) {
    return [
      makeResult(
        'database',
        'Database',
        'error',
        `Database missing at ${displayPath}`,
        {
          summary: `Initialize ${displayPath}`,
          apply: async () => {
            initDatabase({ quiet: true, dbPath });
          },
        },
      ),
    ];
  }

  const stat = fs.statSync(dbPath);
  const writable = (() => {
    try {
      fs.accessSync(dbPath, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  })();

  let schemaVersion = 0;
  let journalMode = '';
  try {
    const database = new Database(dbPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      schemaVersion = Number(
        database.pragma('user_version', { simple: true }) || 0,
      );
      journalMode = String(
        database.pragma('journal_mode', { simple: true }) || '',
      );
    } finally {
      database.close();
    }
  } catch (error) {
    return [
      makeResult(
        'database',
        'Database',
        'error',
        `Failed to open ${displayPath} (${error instanceof Error ? error.message : String(error)})`,
      ),
    ];
  }

  const newerSchema = schemaVersion > DATABASE_SCHEMA_VERSION;
  const staleSchema = schemaVersion < DATABASE_SCHEMA_VERSION;
  const severity: DiagResult['severity'] =
    !writable || newerSchema ? 'error' : staleSchema ? 'warn' : 'ok';

  if (severity === 'ok') {
    const extras = journalMode ? [`${journalMode.toUpperCase()}`] : [];
    return [
      makeResult(
        'database',
        'Database',
        'ok',
        `Schema v${schemaVersion}, ${formatBytes(stat.size)}${extras.length > 0 ? ` (${extras.join(', ')})` : ''}`,
      ),
    ];
  }

  const details = [`Schema v${schemaVersion} at ${displayPath}`];
  if (staleSchema) {
    details.push(`migration available to v${DATABASE_SCHEMA_VERSION}`);
  } else if (newerSchema) {
    details.push(`expected v${DATABASE_SCHEMA_VERSION}`);
  }
  if (!writable) details.push('file is not writable');

  const fix =
    staleSchema && writable && !newerSchema
      ? {
          summary: `Migrate ${displayPath} to schema v${DATABASE_SCHEMA_VERSION}`,
          apply: async () => {
            initDatabase({ quiet: true, dbPath });
          },
        }
      : undefined;

  return [
    makeResult('database', 'Database', severity, details.join(', '), fix),
  ];
}
