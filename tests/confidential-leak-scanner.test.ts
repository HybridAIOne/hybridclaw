import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  listAuditedSessions,
  scanAllAuditSessionsForLeaks,
  scanAuditSessionForLeaks,
} from '../src/audit/leak-scanner.js';
import { parseConfidentialYaml } from '../src/security/confidential-rules.js';

let tempDir: string;

const RULES = parseConfidentialYaml(`
clients:
  - name: Serviceplan
    sensitivity: high
projects:
  - name: Project Falcon
    sensitivity: critical
`);

function writeWireLines(sessionId: string, records: object[]): string {
  const sessionDir = path.join(tempDir, 'audit', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, 'wire.jsonl');
  fs.writeFileSync(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf-8',
  );
  return filePath;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-leak-scan-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('audit log leak scanner', () => {
  test('flags records whose event payload contains confidential terms', () => {
    writeWireLines('session_a', [
      {
        type: 'metadata',
        protocolVersion: '2.0',
        sessionId: 'session_a',
        createdAt: '2025-01-01T00:00:00.000Z',
      },
      {
        version: '2.0',
        seq: 1,
        timestamp: '2025-01-01T00:00:00.001Z',
        runId: 'run_1',
        sessionId: 'session_a',
        event: {
          type: 'user.message',
          content: 'Serviceplan brief about Project Falcon',
        },
      },
      {
        version: '2.0',
        seq: 2,
        timestamp: '2025-01-01T00:00:00.002Z',
        runId: 'run_1',
        sessionId: 'session_a',
        event: {
          type: 'tool.result',
          toolName: 'noop',
          isError: false,
          summary: 'no client info here',
        },
      },
    ]);

    const report = scanAuditSessionForLeaks('session_a', RULES, tempDir);
    expect(report.recordsScanned).toBe(2);
    expect(report.matchedRecords).toHaveLength(1);
    expect(report.matchedRecords[0].eventType).toBe('user.message');
    expect(report.totalMatches).toBeGreaterThanOrEqual(2);
    expect(report.score).toBeGreaterThan(0);
    expect(['high', 'critical']).toContain(report.severity);
  });

  test('returns zero matches when audit log is clean', () => {
    writeWireLines('clean', [
      {
        type: 'metadata',
        protocolVersion: '2.0',
        sessionId: 'clean',
        createdAt: '2025-01-01T00:00:00.000Z',
      },
      {
        version: '2.0',
        seq: 1,
        timestamp: '2025-01-01T00:00:00.001Z',
        runId: 'run_1',
        sessionId: 'clean',
        event: { type: 'user.message', content: 'Just a hello.' },
      },
    ]);
    const report = scanAuditSessionForLeaks('clean', RULES, tempDir);
    expect(report.totalMatches).toBe(0);
    expect(report.matchedRecords).toEqual([]);
    expect(report.score).toBe(0);
    expect(report.severity).toBe('low');
  });

  test('hadPlaceholder flag is true when text already dehydrated', () => {
    writeWireLines('placeholders', [
      {
        type: 'metadata',
        protocolVersion: '2.0',
        sessionId: 'placeholders',
        createdAt: '2025-01-01T00:00:00.000Z',
      },
      {
        version: '2.0',
        seq: 1,
        timestamp: '2025-01-01T00:00:00.001Z',
        runId: 'run_1',
        sessionId: 'placeholders',
        event: {
          type: 'user.message',
          content: 'Brief from «CONF:CLIENT_001» mentioning Project Falcon.',
        },
      },
    ]);
    const report = scanAuditSessionForLeaks('placeholders', RULES, tempDir);
    expect(report.matchedRecords[0].hadPlaceholder).toBe(true);
  });

  test('returns errors when wire file is missing', () => {
    const report = scanAuditSessionForLeaks('does_not_exist', RULES, tempDir);
    expect(report.errors[0]).toMatch(/wire log not found/);
    expect(report.recordsScanned).toBe(0);
  });

  test('listAuditedSessions discovers all sessions', () => {
    writeWireLines('alpha', []);
    writeWireLines('beta', []);
    const sessions = listAuditedSessions(tempDir).map(
      (entry) => entry.sessionId,
    );
    expect(sessions).toEqual(['alpha', 'beta']);
  });

  test('scanAllAuditSessionsForLeaks scans every session', () => {
    writeWireLines('alpha', [
      {
        version: '2.0',
        seq: 1,
        timestamp: '2025-01-01T00:00:00.001Z',
        runId: 'run_1',
        sessionId: 'alpha',
        event: { type: 'user.message', content: 'Project Falcon update' },
      },
    ]);
    writeWireLines('beta', [
      {
        version: '2.0',
        seq: 1,
        timestamp: '2025-01-01T00:00:00.001Z',
        runId: 'run_1',
        sessionId: 'beta',
        event: { type: 'user.message', content: 'Hello world' },
      },
    ]);
    const reports = scanAllAuditSessionsForLeaks(RULES, tempDir);
    expect(reports.map((report) => report.sessionId)).toEqual([
      'alpha',
      'beta',
    ]);
    const alpha = reports.find((report) => report.sessionId === 'alpha');
    expect(alpha?.totalMatches).toBe(1);
    const beta = reports.find((report) => report.sessionId === 'beta');
    expect(beta?.totalMatches).toBe(0);
  });
});
