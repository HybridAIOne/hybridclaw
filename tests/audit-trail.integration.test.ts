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
let verifyAuditSessionChain: typeof import('../src/audit/audit-trail.js').verifyAuditSessionChain;
let getAuditWirePath: typeof import('../src/audit/audit-trail.js').getAuditWirePath;
let createAuditRunId: typeof import('../src/audit/audit-trail.js').createAuditRunId;
let AUDIT_PROTOCOL_VERSION: typeof import('../src/audit/audit-trail.js').AUDIT_PROTOCOL_VERSION;
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
  verifyAuditSessionChain = auditMod.verifyAuditSessionChain;
  getAuditWirePath = auditMod.getAuditWirePath;
  createAuditRunId = auditMod.createAuditRunId;
  AUDIT_PROTOCOL_VERSION = auditMod.AUDIT_PROTOCOL_VERSION;
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

  it('appendAuditEvent writes entries that can be read back from disk', () => {
    const runId = createAuditRunId('test');

    const record1 = appendAuditEvent({
      sessionId,
      runId,
      event: { type: 'test.start', detail: 'first entry' },
    });
    const record2 = appendAuditEvent({
      sessionId,
      runId,
      event: { type: 'test.progress', detail: 'second entry' },
    });
    const record3 = appendAuditEvent({
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

  it('hash chain links each entry to the previous via _prevHash', () => {
    // Use a fresh session so the chain starts clean.
    const chainSessionId = 'audit-chain-test';
    const runId = createAuditRunId('chain');

    const records: WireRecord[] = [];
    for (let i = 0; i < 5; i++) {
      records.push(
        appendAuditEvent({
          sessionId: chainSessionId,
          runId,
          event: { type: 'chain.entry', index: i },
        }),
      );
    }

    // Each record's _prevHash should equal the previous record's _hash.
    for (let i = 1; i < records.length; i++) {
      expect(records[i]._prevHash).toBe(records[i - 1]._hash);
    }

    // All hashes should be unique.
    const hashes = new Set(records.map((r) => r._hash));
    expect(hashes.size).toBe(records.length);
  });

  it('verifyAuditSessionChain passes for a valid chain', () => {
    const validSessionId = 'audit-verify-valid';
    const runId = createAuditRunId('verify');

    for (let i = 0; i < 5; i++) {
      appendAuditEvent({
        sessionId: validSessionId,
        runId,
        event: { type: 'verify.entry', index: i },
      });
    }

    const result = verifyAuditSessionChain(validSessionId);
    expect(result.ok).toBe(true);
    expect(result.checkedRecords).toBe(5);
    expect(result.errors).toHaveLength(0);
    expect(result.lastSeq).toBe(5);
  });

  it('verifyAuditSessionChain detects tampering in the middle of the chain', () => {
    const tamperSessionId = 'audit-tamper-detect';
    const runId = createAuditRunId('tamper');

    for (let i = 0; i < 5; i++) {
      appendAuditEvent({
        sessionId: tamperSessionId,
        runId,
        event: { type: 'tamper.entry', index: i },
      });
    }

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

  it('verifyAuditSessionChain detects removed records (append-only violation)', () => {
    const removeSessionId = 'audit-remove-detect';
    const runId = createAuditRunId('remove');

    for (let i = 0; i < 5; i++) {
      appendAuditEvent({
        sessionId: removeSessionId,
        runId,
        event: { type: 'remove.entry', index: i },
      });
    }

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

  it('sequential appends produce monotonically increasing seq numbers', () => {
    const seqSessionId = 'audit-seq-monotonic';
    const runId = createAuditRunId('seq');

    const records: WireRecord[] = [];
    for (let i = 0; i < 10; i++) {
      records.push(
        appendAuditEvent({
          sessionId: seqSessionId,
          runId,
          event: { type: 'seq.entry', index: i },
        }),
      );
    }

    for (let i = 1; i < records.length; i++) {
      expect(records[i].seq).toBe(records[i - 1].seq + 1);
    }
  });
});
