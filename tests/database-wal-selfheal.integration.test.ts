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
import Database from 'better-sqlite3';
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

function listRebuildFiles(dbPath: string): string[] {
  return fs
    .readdirSync(path.dirname(dbPath))
    .filter((name) => name.includes('.rebuild-'));
}

/** True once a fresh connection's full integrity_check reports something
 * other than a single 'ok' row — used to confirm a corruption fixture
 * actually broke something before relying on it in an assertion. */
function integrityCheckFails(dbPath: string): boolean {
  const check = new Database(dbPath, { readonly: true });
  try {
    // Severe enough corruption can make integrity_check itself throw
    // (e.g. SQLITE_CORRUPT) rather than return rows describing the damage
    // — that's still a failed check, not a passed one.
    const rows = check.pragma('integrity_check') as Array<
      Record<string, unknown>
    >;
    return !(rows.length === 1 && Object.values(rows[0] ?? {})[0] === 'ok');
  } catch {
    return true;
  } finally {
    check.close();
  }
}

/** Byte offset of every occurrence of `needle` in the file at `filePath`. */
function findAllOffsets(filePath: string, needle: Buffer): number[] {
  const data = fs.readFileSync(filePath);
  const offsets: number[] = [];
  let from = 0;
  for (;;) {
    const at = data.indexOf(needle, from);
    if (at === -1) break;
    offsets.push(at);
    from = at + 1;
  }
  return offsets;
}

function overwriteAt(filePath: string, offset: number, bytes: Buffer): void {
  const fd = fs.openSync(filePath, 'r+');
  fs.writeSync(fd, bytes, 0, bytes.length, offset);
  fs.closeSync(fd);
}

function zeroPage(filePath: string, pageIndex0Based: number): void {
  overwriteAt(
    filePath,
    pageIndex0Based * PAGE_SIZE,
    Buffer.alloc(PAGE_SIZE, 0),
  );
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

    const dbBytesBefore = fs.readFileSync(dbPath);
    const walBytesBefore = fs.readFileSync(`${dbPath}-wal`);

    expect(() => initDatabase({ dbPath, quiet: true })).toThrow(
      /manual repair required/,
    );
    // The WAL was put back so nothing is lost for hand-repair, and the main
    // file is byte-for-byte what the failed boot found — the salvage
    // attempts must restore their in-place mutations from the forensic
    // snapshot before giving up.
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
    expect(fs.readFileSync(dbPath).equals(dbBytesBefore)).toBe(true);
    expect(fs.readFileSync(`${dbPath}-wal`).equals(walBytesBefore)).toBe(true);
    expect(listQuarantineFiles(dbPath)).toEqual([]);
    expect(listRebuildFiles(dbPath)).toEqual([]);
  });

  it('self-heals silent index divergence via REINDEX', () => {
    const dbPath = freshDbPath('index-divergence');
    initDatabase({ dbPath, quiet: true });
    withMemoryDatabase((database) => {
      database.prepare('CREATE TABLE t (x TEXT)').run();
      database.prepare('CREATE INDEX idx_t_x ON t (x)').run();
      const insert = database.prepare('INSERT INTO t VALUES (?)');
      for (let i = 0; i < 50; i++) insert.run(`filler-${i}`);
      insert.run('A'.repeat(64));
    });
    closeDatabase();

    // Locate the rootpage of the table vs. the index so we corrupt the
    // TABLE's copy of the distinctive value, not the index's — that's what
    // makes the index and table content disagree without either one alone
    // looking corrupt.
    const inspect = new Database(dbPath, { readonly: true });
    const rootpages = inspect
      .prepare(
        "SELECT name, rootpage FROM sqlite_master WHERE name IN ('t', 'idx_t_x')",
      )
      .all() as Array<{ name: string; rootpage: number }>;
    inspect.close();
    const tableRootpage = rootpages.find((r) => r.name === 't')?.rootpage;
    expect(tableRootpage).toBeDefined();

    const needle = Buffer.from('A'.repeat(64));
    const offsets = findAllOffsets(dbPath, needle);
    expect(offsets.length).toBeGreaterThan(0);
    const tableOffset = offsets.find(
      (offset) => Math.floor(offset / PAGE_SIZE) + 1 === tableRootpage,
    );
    expect(tableOffset).toBeDefined();

    // Overwrite only the table's copy of the value (same length, so no
    // structural change) — the index still points at a value the table no
    // longer contains.
    overwriteAt(dbPath, tableOffset as number, Buffer.from('B'.repeat(64)));

    expect(integrityCheckFails(dbPath)).toBe(true);

    initDatabase({ dbPath, quiet: true });
    const count = withMemoryDatabase(
      (database) =>
        database
          .prepare('SELECT COUNT(*) AS n FROM t WHERE x = ?')
          .get('B'.repeat(64)) as { n: number },
    );
    expect(count.n).toBe(1);

    expect(
      listQuarantineFiles(dbPath).some((name) =>
        name.startsWith('hybridclaw.db.corrupt-'),
      ),
    ).toBe(true);
  });

  it('rebuilds from readable rows when a table page is damaged', () => {
    const dbPath = freshDbPath('table-damage');
    initDatabase({ dbPath, quiet: true });
    withMemoryDatabase((database) => {
      database
        .prepare('CREATE TABLE big (id INTEGER PRIMARY KEY, v TEXT)')
        .run();
      const insert = database.prepare('INSERT INTO big (id, v) VALUES (?, ?)');
      for (let i = 0; i < 2000; i++) {
        insert.run(i, `val-${i}-${'x'.repeat(90)}`);
      }
    });
    closeDatabase();

    // Find a page holding a known row's value and zero the whole page —
    // damages the table btree without touching the header or schema.
    const target = `val-1000-${'x'.repeat(90)}`;
    const offsets = findAllOffsets(dbPath, Buffer.from(target));
    expect(offsets.length).toBeGreaterThan(0);
    const pageIndex0Based = Math.floor(offsets[0] / PAGE_SIZE);
    zeroPage(dbPath, pageIndex0Based);

    expect(integrityCheckFails(dbPath)).toBe(true);

    initDatabase({ dbPath, quiet: true });
    const count = withMemoryDatabase(
      (database) =>
        database.prepare('SELECT COUNT(*) AS n FROM big').get() as {
          n: number;
        },
    );
    // Only the rows on the zeroed page may be lost (~40 rows of this size
    // per 4KB page) — the walk must resume past the damage, not abandon the
    // rest of the table.
    expect(count.n).toBeLessThan(2000);
    expect(count.n).toBeGreaterThanOrEqual(1900);
    const lastRow = withMemoryDatabase(
      (database) =>
        database.prepare('SELECT v FROM big WHERE id = 1999').get() as
          | { v: string }
          | undefined,
    );
    expect(lastRow?.v).toBe(`val-1999-${'x'.repeat(90)}`);

    // Migrations recreate the FTS index that virtual-table skipping dropped.
    const ftsTable = withMemoryDatabase(
      (database) =>
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE name = 'recent_chat_message_search'",
          )
          .get() as { name: string } | undefined,
    );
    expect(ftsTable?.name).toBe('recent_chat_message_search');

    expect(
      listQuarantineFiles(dbPath).some((name) =>
        name.startsWith('hybridclaw.db.corrupt-'),
      ),
    ).toBe(true);
    expect(listRebuildFiles(dbPath)).toEqual([]);
  });

  it('keeps indexes and triggers when rebuilding from readable rows', () => {
    const dbPath = freshDbPath('schema-preserved');
    initDatabase({ dbPath, quiet: true });
    withMemoryDatabase((database) => {
      database
        .prepare('CREATE TABLE s (id INTEGER PRIMARY KEY, v TEXT)')
        .run();
      database.prepare('CREATE INDEX idx_s_v ON s (v)').run();
      database
        .prepare(
          `CREATE TRIGGER trg_s_touch AFTER INSERT ON s
           BEGIN UPDATE s SET v = v WHERE id = new.id; END`,
        )
        .run();
      const insert = database.prepare('INSERT INTO s (id, v) VALUES (?, ?)');
      for (let i = 0; i < 300; i++) {
        insert.run(i, `row-${i}-${'y'.repeat(90)}`);
      }
    });
    closeDatabase();

    const target = `row-150-${'y'.repeat(90)}`;
    const offsets = findAllOffsets(dbPath, Buffer.from(target));
    expect(offsets.length).toBeGreaterThan(0);
    zeroPage(dbPath, Math.floor(offsets[0] / PAGE_SIZE));

    expect(integrityCheckFails(dbPath)).toBe(true);

    initDatabase({ dbPath, quiet: true });
    const schemaObjects = withMemoryDatabase(
      (database) =>
        database
          .prepare(
            "SELECT type, name FROM sqlite_master WHERE name IN ('idx_s_v', 'trg_s_touch')",
          )
          .all() as Array<{ type: string; name: string }>,
    );
    expect(schemaObjects.some((o) => o.name === 'idx_s_v' && o.type === 'index')).toBe(
      true,
    );
    expect(
      schemaObjects.some((o) => o.name === 'trg_s_touch' && o.type === 'trigger'),
    ).toBe(true);
  });
});
