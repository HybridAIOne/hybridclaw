/**
 * Integration test: WAL self-heal at database startup.
 *
 * A hard kill (or a backup restored without its sidecar files) can leave a
 * `-wal` file next to the database that no longer matches the main file.
 * SQLite recovers such a WAL as long as it is internally consistent, and the
 * resulting merged view fails with SQLITE_CORRUPT on every read — forever,
 * because the WAL survives restarts. initDatabase() must detect this at boot,
 * quarantine the WAL when the main file alone is intact, and refuse loudly
 * when it is not.
 *
 * The poisoned WAL is crafted byte-by-byte per the documented WAL format: a
 * single committed frame rewriting page 1 with a "database size" far smaller
 * than the real file, which truncates the recovered view and makes ordinary
 * reads hit invalid page references.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let tmpDir: string;
let initDatabase: typeof import('../src/memory/db.js').initDatabase;
let closeDatabase: typeof import('../src/memory/db.js').closeDatabase;
let withMemoryDatabase: typeof import('../src/memory/db.js').withMemoryDatabase;

const PAGE_SIZE = 4096;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-wal-selfheal-'));

  // Point the runtime home at our temp dir so side-effecty config imports
  // resolve harmlessly.
  process.env.HYBRIDCLAW_DATA_DIR = tmpDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';

  vi.resetModules();
  const dbMod = await import('../src/memory/db.js');
  initDatabase = dbMod.initDatabase;
  closeDatabase = dbMod.closeDatabase;
  withMemoryDatabase = dbMod.withMemoryDatabase;
});

afterEach(() => {
  closeDatabase();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function freshDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(tmpDir, `${name}-`));
  return path.join(dir, 'hybridclaw.db');
}

/**
 * The WAL checksum: a cumulative Fletcher-style sum over 32-bit words, two
 * words per step. Magic 0x377f0682 selects little-endian word order.
 */
function walChecksum(
  data: Buffer,
  seed: [number, number] = [0, 0],
): [number, number] {
  let [s0, s1] = seed;
  for (let i = 0; i < data.length; i += 8) {
    s0 = (s0 + data.readUInt32LE(i) + s1) >>> 0;
    s1 = (s1 + data.readUInt32LE(i + 4) + s0) >>> 0;
  }
  return [s0, s1];
}

/**
 * Write a syntactically valid WAL beside dbPath containing one committed
 * frame: a copy of the database's real page 1 whose header claims the whole
 * database is only `claimedPages` pages long. Recovering it truncates the
 * reader's view of the database — the poisoned-WAL state a hard kill can
 * leave behind.
 */
function writePoisonedWal(dbPath: string, claimedPages: number): void {
  const page1 = Buffer.alloc(PAGE_SIZE);
  const fd = fs.openSync(dbPath, 'r');
  fs.readSync(fd, page1, 0, PAGE_SIZE, 0);
  fs.closeSync(fd);

  // Rewrite the in-page header: db size in pages, with the change counter
  // and version-valid-for bumped in lockstep so the header stays credible.
  const changeCounter = page1.readUInt32BE(24) + 1;
  page1.writeUInt32BE(changeCounter, 24);
  page1.writeUInt32BE(claimedPages, 28);
  page1.writeUInt32BE(changeCounter, 92);

  const salt1 = 0x11111111;
  const salt2 = 0x22222222;

  const header = Buffer.alloc(32);
  header.writeUInt32BE(0x377f0682, 0); // magic, little-endian checksums
  header.writeUInt32BE(3007000, 4); // format version
  header.writeUInt32BE(PAGE_SIZE, 8);
  header.writeUInt32BE(0, 12); // checkpoint sequence
  header.writeUInt32BE(salt1, 16);
  header.writeUInt32BE(salt2, 20);
  let sum = walChecksum(header.subarray(0, 24));
  header.writeUInt32BE(sum[0], 24);
  header.writeUInt32BE(sum[1], 28);

  const frameHeader = Buffer.alloc(24);
  frameHeader.writeUInt32BE(1, 0); // page number
  frameHeader.writeUInt32BE(claimedPages, 4); // commit: db size after txn
  frameHeader.writeUInt32BE(salt1, 8);
  frameHeader.writeUInt32BE(salt2, 12);
  sum = walChecksum(frameHeader.subarray(0, 8), sum);
  sum = walChecksum(page1, sum);
  frameHeader.writeUInt32BE(sum[0], 16);
  frameHeader.writeUInt32BE(sum[1], 20);

  fs.writeFileSync(`${dbPath}-wal`, Buffer.concat([header, frameHeader, page1]));
}

function listQuarantineFiles(dbPath: string): string[] {
  return fs
    .readdirSync(path.dirname(dbPath))
    .filter((name) => name.includes('.corrupt-'));
}

describe('database WAL self-heal', () => {
  it('closes cleanly leaving no WAL behind', () => {
    const dbPath = freshDbPath('clean-close');
    initDatabase({ dbPath, quiet: true });
    withMemoryDatabase((database) => {
      database.prepare('CREATE TABLE t (x)').run();
      database.prepare('INSERT INTO t VALUES (1)').run();
    });
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);

    closeDatabase();
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
  });

  it('quarantines a stale WAL and boots from the intact main file', () => {
    const dbPath = freshDbPath('selfheal');
    initDatabase({ dbPath, quiet: true });
    withMemoryDatabase((database) => {
      database.prepare('CREATE TABLE t (x)').run();
      const insert = database.prepare('INSERT INTO t VALUES (?)');
      for (let i = 0; i < 500; i++) insert.run(`row-${i}`);
    });
    closeDatabase();

    const realPages = fs.statSync(dbPath).size / PAGE_SIZE;
    expect(realPages).toBeGreaterThan(4);
    writePoisonedWal(dbPath, 2);

    initDatabase({ dbPath, quiet: true });
    const count = withMemoryDatabase(
      (database) =>
        database.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number },
    );
    expect(count.n).toBe(500);

    // The quarantine must actually have triggered (proving the crafted WAL
    // really corrupted the merged view), and the poisoned WAL is preserved
    // for inspection rather than deleted.
    const quarantined = listQuarantineFiles(dbPath);
    expect(
      quarantined.some((name) => name.startsWith('hybridclaw.db-wal.corrupt-')),
    ).toBe(true);
    // The main database file was never rewritten by the recovery.
    expect(fs.statSync(dbPath).size / PAGE_SIZE).toBe(realPages);
  });

  it('restores the WAL and throws when the main file itself is corrupt', () => {
    const dbPath = freshDbPath('hopeless');
    initDatabase({ dbPath, quiet: true });
    withMemoryDatabase((database) => {
      database.prepare('CREATE TABLE t (x)').run();
      database.prepare('INSERT INTO t VALUES (1)').run();
    });
    closeDatabase();

    writePoisonedWal(dbPath, 2);
    // Trash the main file's header — no amount of WAL-dropping can fix this.
    const garbage = Buffer.alloc(100, 0xab);
    const fd = fs.openSync(dbPath, 'r+');
    fs.writeSync(fd, garbage, 0, garbage.length, 0);
    fs.closeSync(fd);

    expect(() => initDatabase({ dbPath, quiet: true })).toThrow(
      /manual repair required/,
    );
    // The WAL was put back so nothing is lost for hand-repair.
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
    expect(listQuarantineFiles(dbPath)).toEqual([]);
  });
});
