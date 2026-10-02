/**
 * Integration test: Audit trail hash chain integrity.
 *
 * Exercises the real file-based audit trail — writing entries to a temp
 * directory, verifying the hash chain, and confirming tamper detection.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let tmpDir: string;

let appendAuditEvent: typeof import('../src/audit/audit-trail.js').appendAuditEvent;
let flushAuditTrail: typeof import('../src/audit/audit-trail.js').flushAuditTrail;
let verifyAuditSessionChain: typeof import('../src/audit/audit-trail.js').verifyAuditSessionChain;
let getAuditWirePath: typeof import('../src/audit/audit-trail.js').getAuditWirePath;
let createAuditRunId: typeof import('../src/audit/audit-trail.js').createAuditRunId;
let AUDIT_PROTOCOL_VERSION: typeof import('../src/audit/audit-trail.js').AUDIT_PROTOCOL_VERSION;
let initDatabase: typeof import('../src/memory/db.js').initDatabase;
let createConfidentialRuntimeContext: typeof import('../src/security/confidential-runtime.js').createConfidentialRuntimeContext;
let parseConfidentialYaml: typeof import('../src/security/confidential-rules.js').parseConfidentialYaml;
type WireRecord = import('../src/audit/audit-trail.js').WireRecord;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-audit-integration-'));

  // The env var alone is insufficient — DATA_DIR is resolved at module load.
  // The vi.doMock below ensures the config module returns our temp dir.
  process.env.HYBRIDCLAW_DATA_DIR = tmpDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';

  vi.resetModules();

  // Stub the config module so DATA_DIR resolves to our temp dir.
  vi.doMock('../src/config/config.js', async (importOriginal) => {
    const original =
      (await importOriginal()) as typeof import('../src/config/config.js');
    return { ...original, DATA_DIR: tmpDir };
  });

  const auditMod = await import('../src/audit/audit-trail.js');
  appendAuditEvent = auditMod.appendAuditEvent;
  flushAuditTrail = auditMod.flushAuditTrail;
  verifyAuditSessionChain = auditMod.verifyAuditSessionChain;
  getAuditWirePath = auditMod.getAuditWirePath;
  createAuditRunId = auditMod.createAuditRunId;
  AUDIT_PROTOCOL_VERSION = auditMod.AUDIT_PROTOCOL_VERSION;

  const dbMod = await import('../src/memory/db.js');
  initDatabase = dbMod.initDatabase;
  initDatabase({ quiet: true, dbPath: path.join(tmpDir, 'audit.db') });

  const confidentialRuntimeMod = await import(
    '../src/security/confidential-runtime.js'
  );
  createConfidentialRuntimeContext =
    confidentialRuntimeMod.createConfidentialRuntimeContext;
  const confidentialRulesMod = await import(
    '../src/security/confidential-rules.js'
  );
  parseConfidentialYaml = confidentialRulesMod.parseConfidentialYaml;
});

afterAll(() => {
  vi.restoreAllMocks();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Cleanup is best-effort.
  }
});

describe('audit trail integration', () => {
  const sessionId = 'audit-test-session-1';

  it('appendAuditEvent writes entries that can be read back from disk', async () => {
    const runId = createAuditRunId('test');

    const record1 = await appendAuditEvent({
      sessionId,
      runId,
      event: { type: 'test.start', detail: 'first entry' },
    });
    const record2 = await appendAuditEvent({
      sessionId,
      runId,
      event: { type: 'test.progress', detail: 'second entry' },
    });
    const record3 = await appendAuditEvent({
      sessionId,
      runId,
      event: { type: 'test.end', detail: 'third entry' },
    });

    expect(record1.seq).toBe(1);
    expect(record2.seq).toBe(2);
    expect(record3.seq).toBe(3);
    expect(record1.version).toBe(AUDIT_PROTOCOL_VERSION);

    // Read back from the wire file.
    const wirePath = getAuditWirePath(sessionId);
    const lines = fs
      .readFileSync(wirePath, 'utf-8')
      .split('\n')
      .filter(Boolean);
    // First line is metadata, then 3 records.
    expect(lines.length).toBe(4);

    const parsedRecord = JSON.parse(lines[1]);
    expect(parsedRecord.seq).toBe(1);
    expect(parsedRecord.event.type).toBe('test.start');
  });

  it('hash chain links each entry to the previous via _prevHash', async () => {
    // Use a fresh session so the chain starts clean.
    const chainSessionId = 'audit-chain-test';
    const runId = createAuditRunId('chain');

    const pending: Promise<WireRecord>[] = [];
    for (let i = 0; i < 5; i++) {
      pending.push(
        appendAuditEvent({
          sessionId: chainSessionId,
          runId,
          event: { type: 'chain.entry', index: i },
        }),
      );
    }
    const records = await Promise.all(pending);

    // Each record's _prevHash should equal the previous record's _hash.
    for (let i = 1; i < records.length; i++) {
      expect(records[i]._prevHash).toBe(records[i - 1]._hash);
    }

    // All hashes should be unique.
    const hashes = new Set(records.map((r) => r._hash));
    expect(hashes.size).toBe(records.length);
  });

  it('verifyAuditSessionChain passes for a valid chain', async () => {
    const validSessionId = 'audit-verify-valid';
    const runId = createAuditRunId('verify');

    for (let i = 0; i < 5; i++) {
      void appendAuditEvent({
        sessionId: validSessionId,
        runId,
        event: { type: 'verify.entry', index: i },
      });
    }
    await flushAuditTrail();

    const result = verifyAuditSessionChain(validSessionId);
    expect(result.ok).toBe(true);
    expect(result.checkedRecords).toBe(5);
    expect(result.errors).toHaveLength(0);
    expect(result.lastSeq).toBe(5);
  });

  it('verifyAuditSessionChain detects tampering in the middle of the chain', async () => {
    const tamperSessionId = 'audit-tamper-detect';
    const runId = createAuditRunId('tamper');

    for (let i = 0; i < 5; i++) {
      void appendAuditEvent({
        sessionId: tamperSessionId,
        runId,
        event: { type: 'tamper.entry', index: i },
      });
    }
    await flushAuditTrail();

    // Verify the chain is initially valid.
    const beforeTamper = verifyAuditSessionChain(tamperSessionId);
    expect(beforeTamper.ok).toBe(true);

    // Tamper with the wire file: modify a record in the middle.
    const wirePath = getAuditWirePath(tamperSessionId);
    const lines = fs.readFileSync(wirePath, 'utf-8').split('\n');
    // Line 0 is metadata, lines 1-5 are records. Modify line 3 (record 3).
    const tampered = JSON.parse(lines[3]);
    tampered.event.index = 999;
    lines[3] = JSON.stringify(tampered);
    fs.writeFileSync(wirePath, lines.join('\n'), 'utf-8');

    // verifyAuditSessionChain always reads from disk, bypassing the
    // in-memory sessionStateCache, so it detects the tampered file.
    const afterTamper = verifyAuditSessionChain(tamperSessionId);
    expect(afterTamper.ok).toBe(false);
    expect(afterTamper.errors.length).toBeGreaterThan(0);
    // The error should mention hash mismatch.
    const hasHashError = afterTamper.errors.some(
      (e) => e.includes('hash mismatch') || e.includes('previous hash'),
    );
    expect(
      hasHashError,
      `Expected hash mismatch error, got: ${afterTamper.errors.join('; ')}`,
    ).toBe(true);
  });

  it('verifyAuditSessionChain detects removed records (append-only violation)', async () => {
    const removeSessionId = 'audit-remove-detect';
    const runId = createAuditRunId('remove');

    for (let i = 0; i < 5; i++) {
      void appendAuditEvent({
        sessionId: removeSessionId,
        runId,
        event: { type: 'remove.entry', index: i },
      });
    }
    await flushAuditTrail();

    // Remove record 3 (line index 3) from the wire file.
    const wirePath = getAuditWirePath(removeSessionId);
    const lines = fs
      .readFileSync(wirePath, 'utf-8')
      .split('\n')
      .filter(Boolean);
    // Remove the 3rd record (index 3, which is seq 3).
    lines.splice(3, 1);
    fs.writeFileSync(wirePath, `${lines.join('\n')}\n`, 'utf-8');

    const result = verifyAuditSessionChain(removeSessionId);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('verifyAuditSessionChain reports error for empty/missing session', () => {
    const result = verifyAuditSessionChain('nonexistent-session-xyz');
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('sequential appends produce monotonically increasing seq numbers', async () => {
    const seqSessionId = 'audit-seq-monotonic';
    const runId = createAuditRunId('seq');

    const pending: Promise<WireRecord>[] = [];
    for (let i = 0; i < 10; i++) {
      pending.push(
        appendAuditEvent({
          sessionId: seqSessionId,
          runId,
          event: { type: 'seq.entry', index: i },
        }),
      );
    }
    const records = await Promise.all(pending);

    for (let i = 1; i < records.length; i++) {
      expect(records[i].seq).toBe(records[i - 1].seq + 1);
    }
  });

  it('confidential runtime writes metadata-only mask and rehydrate audit events', async () => {
    const secretSessionId = 'audit-confidential-runtime';
    const runId = createAuditRunId('secret-redaction');
    const clientSecret = 'AsterWorks Labs';
    const contractSecret = 'CONTRACT-ASTER-2026-001';
    const ruleSet = parseConfidentialYaml(
      `
clients:
  - name: ${clientSecret}
    sensitivity: high
keywords:
  - term: ${contractSecret}
    sensitivity: critical
`,
      'fixtures:trusted-agents',
    );
    const confidential = createConfidentialRuntimeContext(ruleSet, {
      audit: { sessionId: secretSessionId, runId },
    });

    const [message] = confidential.dehydrate(
      [
        {
          role: 'user',
          content: `${clientSecret} signed ${contractSecret} for ${clientSecret}.`,
        },
      ],
      'test.messages',
    );
    expect(String(message?.content)).not.toContain(clientSecret);
    expect(String(message?.content)).not.toContain(contractSecret);

    const rehydrated = confidential.rehydrate(
      String(message?.content),
      'test.result',
    );
    expect(rehydrated).toContain(clientSecret);
    expect(rehydrated).toContain(contractSecret);

    await flushAuditTrail();
    const wirePath = getAuditWirePath(secretSessionId);
    const wireText = fs.readFileSync(wirePath, 'utf-8');
    expect(wireText).not.toContain(clientSecret);
    expect(wireText).not.toContain(contractSecret);

    const records = wireText
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry): entry is WireRecord => entry.event != null);
    expect(records.map((record) => record.event.type)).toEqual([
      'secret.masked',
      'secret.rehydrated',
    ]);
    expect(records[0]?.event).toMatchObject({
      type: 'secret.masked',
      surface: 'test.messages',
      count: 3,
      classes: [
        { class: 'client', count: 2 },
        { class: 'keyword', count: 1 },
      ],
      rulesSource: 'fixtures:trusted-agents',
    });
    expect(records[1]?.event).toMatchObject({
      type: 'secret.rehydrated',
      surface: 'test.result',
      count: 3,
      classes: [
        { class: 'client', count: 2 },
        { class: 'keyword', count: 1 },
      ],
      rulesSource: 'fixtures:trusted-agents',
    });

    const result = verifyAuditSessionChain(secretSessionId);
    expect(result.ok).toBe(true);
    expect(result.checkedRecords).toBe(2);
  });
  it('commits concurrent appends in call order per session', async () => {
    const runId = createAuditRunId('order');
    const records = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        appendAuditEvent({
          sessionId: index % 2 === 0 ? 'audit-order-a' : 'audit-order-b',
          runId,
          event: { type: 'order.entry', index },
        }),
      ),
    );

    for (const [sessionId, offset] of [
      ['audit-order-a', 0],
      ['audit-order-b', 1],
    ] as const) {
      const own = records.filter((record) => record.sessionId === sessionId);
      expect(own.map((record) => record.seq)).toEqual(
        own.map((_, i) => i + 1),
      );
      expect(own.map((record) => record.event.index)).toEqual(
        own.map((_, i) => 2 * i + offset),
      );
      expect(verifyAuditSessionChain(sessionId)).toMatchObject({
        ok: true,
        checkedRecords: 10,
      });
    }
  });

  it('a fresh process resumes the chain past an oversized record and a malformed tail', async () => {
    const coldSessionId = 'audit-cold-start';
    const runId = createAuditRunId('cold');
    await appendAuditEvent({
      sessionId: coldSessionId,
      runId,
      event: { type: 'cold.small' },
    });
    // Larger than one 64 KiB head read, so the line straddles chunks.
    const big = await appendAuditEvent({
      sessionId: coldSessionId,
      runId,
      event: { type: 'cold.big', detail: 'x'.repeat(200_000) },
    });
    fs.appendFileSync(getAuditWirePath(coldSessionId), '{"seq":\n\n');

    vi.resetModules();
    const fresh = await import('../src/audit/audit-trail.js');
    const next = await fresh.appendAuditEvent({
      sessionId: coldSessionId,
      runId,
      event: { type: 'cold.after-restart' },
    });

    expect(next.seq).toBe(big.seq + 1);
    expect(next._prevHash).toBe(big._hash);
    const result = fresh.verifyAuditSessionChain(coldSessionId);
    expect(result.checkedRecords).toBe(3);
    expect(result.errors).toEqual([expect.stringContaining('invalid JSON')]);
  });

  it('a failed write rejects and leaves the chain where it was', async () => {
    const failSessionId = 'audit-write-failure';
    const runId = createAuditRunId('fail');
    const first = await appendAuditEvent({
      sessionId: failSessionId,
      runId,
      event: { type: 'fail.before' },
    });
    const wirePath = getAuditWirePath(failSessionId);
    const durable = fs.readFileSync(wirePath);
    fs.rmSync(wirePath);
    fs.mkdirSync(wirePath); // opening a directory for append fails (EISDIR)

    await expect(
      appendAuditEvent({
        sessionId: failSessionId,
        runId,
        event: { type: 'fail.lost' },
      }),
    ).rejects.toThrow();

    fs.rmdirSync(wirePath);
    fs.writeFileSync(wirePath, durable);
    const next = await appendAuditEvent({
      sessionId: failSessionId,
      runId,
      event: { type: 'fail.after' },
    });
    expect(next.seq).toBe(first.seq + 1);
    expect(next._prevHash).toBe(first._hash);
    expect(verifyAuditSessionChain(failSessionId)).toMatchObject({
      ok: true,
      checkedRecords: 2,
    });
  });

  it('an unserializable event fails alone and the chain skips it', async () => {
    const skipSessionId = 'audit-unserializable';
    const runId = createAuditRunId('skip');
    const [before, broken, after] = await Promise.allSettled([
      appendAuditEvent({
        sessionId: skipSessionId,
        runId,
        event: { type: 'skip.before' },
      }),
      appendAuditEvent({
        sessionId: skipSessionId,
        runId,
        event: { type: 'skip.broken', value: 1n },
      }),
      appendAuditEvent({
        sessionId: skipSessionId,
        runId,
        event: { type: 'skip.after' },
      }),
    ]);

    expect(broken.status).toBe('rejected');
    if (before.status !== 'fulfilled' || after.status !== 'fulfilled') {
      throw new Error('Expected the serializable appends to commit.');
    }
    expect(after.value.seq).toBe(before.value.seq + 1);
    expect(after.value._prevHash).toBe(before.value._hash);
    expect(verifyAuditSessionChain(skipSessionId)).toMatchObject({
      ok: true,
      checkedRecords: 2,
    });
  });
});
