import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  directionForEventType,
  listAuditedSessions,
  PROMPT_BEARING_EVENT_TYPES,
  scanAllAuditSessionsForLeaks,
  scanAuditSessionForLeaks,
  summarizeLeakReports,
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
          type: 'turn.start',
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
    expect(report.matchedRecords[0].eventType).toBe('turn.start');
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
        event: { type: 'turn.start', content: 'Just a hello.' },
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
          type: 'turn.start',
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

  test('skips telemetry/lifecycle event types and counts them as skipped', () => {
    writeWireLines('mixed', [
      {
        version: '2.0',
        seq: 1,
        timestamp: '2025-01-01T00:00:00.001Z',
        runId: 'run_1',
        sessionId: 'mixed',
        // model.usage payloads contain provider names ("HybridAI"); we must
        // not flag them as confidential leaks, otherwise every turn shows
        // a false positive against a HybridAI rule.
        event: {
          type: 'model.usage',
          provider: 'Serviceplan',
          model: 'gpt-5.1',
        },
      },
      {
        version: '2.0',
        seq: 2,
        timestamp: '2025-01-01T00:00:00.002Z',
        runId: 'run_1',
        sessionId: 'mixed',
        event: { type: 'session.start', userId: 'Serviceplan' },
      },
      {
        version: '2.0',
        seq: 3,
        timestamp: '2025-01-01T00:00:00.003Z',
        runId: 'run_1',
        sessionId: 'mixed',
        event: { type: 'turn.start', content: 'About Serviceplan today' },
      },
    ]);
    const report = scanAuditSessionForLeaks('mixed', RULES, tempDir);
    expect(report.recordsScanned).toBe(1);
    expect(report.recordsSkippedByType).toBe(2);
    expect(report.matchedRecords).toHaveLength(1);
    expect(report.matchedRecords[0].eventType).toBe('turn.start');
  });

  test('PROMPT_BEARING_EVENT_TYPES contains the expected canonical types', () => {
    expect(PROMPT_BEARING_EVENT_TYPES.has('turn.start')).toBe(true);
    expect(PROMPT_BEARING_EVENT_TYPES.has('turn.end')).toBe(true);
    expect(PROMPT_BEARING_EVENT_TYPES.has('tool.call')).toBe(true);
    expect(PROMPT_BEARING_EVENT_TYPES.has('tool.result')).toBe(true);
    expect(PROMPT_BEARING_EVENT_TYPES.has('approval.request')).toBe(true);
    expect(PROMPT_BEARING_EVENT_TYPES.has('model.usage')).toBe(false);
    expect(PROMPT_BEARING_EVENT_TYPES.has('session.start')).toBe(false);
    expect(PROMPT_BEARING_EVENT_TYPES.has('authorization.check')).toBe(false);
  });

  test('caller can override scanEventTypes', () => {
    writeWireLines('override', [
      {
        version: '2.0',
        seq: 1,
        timestamp: '2025-01-01T00:00:00.001Z',
        runId: 'run_1',
        sessionId: 'override',
        event: { type: 'custom.weird', text: 'Project Falcon hidden' },
      },
    ]);
    const report = scanAuditSessionForLeaks('override', RULES, tempDir, {
      scanEventTypes: new Set(['custom.weird']),
    });
    expect(report.matchedRecords).toHaveLength(1);
  });

  test('summarizeLeakReports buckets by session severity', () => {
    const reports = [
      {
        sessionId: 'a',
        filePath: 'a',
        recordsScanned: 1,
        recordsSkippedByType: 0,
        matchedRecords: [],
        totalMatches: 5,
        rawScore: 200,
        score: 20,
        severity: 'critical' as const,
        errors: [],
      },
      {
        sessionId: 'b',
        filePath: 'b',
        recordsScanned: 1,
        recordsSkippedByType: 0,
        matchedRecords: [],
        totalMatches: 2,
        rawScore: 50,
        score: 5,
        severity: 'high' as const,
        errors: [],
      },
      {
        sessionId: 'c',
        filePath: 'c',
        recordsScanned: 1,
        recordsSkippedByType: 0,
        matchedRecords: [],
        totalMatches: 0,
        rawScore: 0,
        score: 0,
        severity: 'low' as const,
        errors: [],
      },
    ];
    const summary = summarizeLeakReports(reports);
    expect(summary.totalSessions).toBe(3);
    expect(summary.affectedSessions).toBe(2);
    expect(summary.totalMatches).toBe(7);
    expect(summary.bySeverity.critical).toBe(1);
    expect(summary.bySeverity.high).toBe(1);
    expect(summary.bySeverity.medium).toBe(0);
    expect(summary.bySeverity.low).toBe(0);
    // Empty matchedRecords on all inputs → direction buckets stay zero.
    expect(summary.byDirection.in.matches).toBe(0);
    expect(summary.byDirection.out.matches).toBe(0);
    expect(summary.byDirection.tool.matches).toBe(0);
  });

  test('directionForEventType classifies the canonical event types', () => {
    expect(directionForEventType('turn.start')).toBe('in');
    expect(directionForEventType('prompt')).toBe('in');
    expect(directionForEventType('message')).toBe('in');
    expect(directionForEventType('turn.end')).toBe('out');
    expect(directionForEventType('text')).toBe('out');
    expect(directionForEventType('thinking')).toBe('out');
    expect(directionForEventType('approval.request')).toBe('out');
    expect(directionForEventType('tool.call')).toBe('tool');
    expect(directionForEventType('tool.result')).toBe('tool');
    expect(directionForEventType('skill.execution')).toBe('tool');
    expect(directionForEventType('model.usage')).toBeNull();
    expect(directionForEventType('unknown.weird')).toBeNull();
  });

  test('summarizeLeakReports splits matched records by direction', () => {
    writeWireLines('directional', [
      {
        version: '2.0',
        seq: 1,
        timestamp: '2025-01-01T00:00:00.001Z',
        runId: 'run_1',
        sessionId: 'directional',
        event: { type: 'turn.start', content: 'About Serviceplan' },
      },
      {
        version: '2.0',
        seq: 2,
        timestamp: '2025-01-01T00:00:00.002Z',
        runId: 'run_1',
        sessionId: 'directional',
        event: { type: 'turn.end', content: 'Reply about Project Falcon' },
      },
      {
        version: '2.0',
        seq: 3,
        timestamp: '2025-01-01T00:00:00.003Z',
        runId: 'run_1',
        sessionId: 'directional',
        event: { type: 'tool.result', summary: 'Project Falcon launched' },
      },
    ]);
    const reports = [scanAuditSessionForLeaks('directional', RULES, tempDir)];
    const summary = summarizeLeakReports(reports);
    expect(summary.byCategory.in.records).toBe(1);
    expect(summary.byCategory.out.records).toBe(1);
    expect(summary.byCategory.tool.records).toBe(1);
    expect(summary.byCategory.in.matches).toBeGreaterThanOrEqual(1);
    expect(summary.byCategory.out.matches).toBeGreaterThanOrEqual(1);
    expect(summary.byCategory.tool.matches).toBeGreaterThanOrEqual(1);
    // All three records came from the same session — the per-bucket
    // session count should report 1 (deduped), not 3.
    expect(summary.byCategory.in.sessions).toBe(1);
    expect(summary.byCategory.out.sessions).toBe(1);
    expect(summary.byCategory.tool.sessions).toBe(1);
  });

  test('classifies matches inside URLs into the url bucket', () => {
    writeWireLines('urls', [
      {
        version: '2.0',
        seq: 1,
        timestamp: '2025-01-01T00:00:00.001Z',
        runId: 'run_1',
        sessionId: 'urls',
        event: {
          type: 'tool.result',
          resultSummary:
            'Found article at https://news.example.com/Serviceplan/2026',
        },
      },
      {
        version: '2.0',
        seq: 2,
        timestamp: '2025-01-01T00:00:00.002Z',
        runId: 'run_1',
        sessionId: 'urls',
        event: {
          type: 'tool.result',
          resultSummary:
            'See [Spendenseite](/unterstuetzung#Serviceplan) for details',
        },
      },
      {
        version: '2.0',
        seq: 3,
        timestamp: '2025-01-01T00:00:00.003Z',
        runId: 'run_1',
        sessionId: 'urls',
        event: { type: 'turn.start', userInput: 'Tell me about Serviceplan' },
      },
    ]);
    const reports = [scanAuditSessionForLeaks('urls', RULES, tempDir)];
    const summary = summarizeLeakReports(reports);
    // Two URL-bucketed records (https + markdown), one prose record.
    expect(summary.byCategory.url.records).toBe(2);
    expect(summary.byCategory.in.records).toBe(1);
    expect(summary.byCategory.tool.records).toBe(0);
  });

  test('only scans whitelisted fields per event type — ignores metadata fields', () => {
    writeWireLines('targeted', [
      {
        version: '2.0',
        seq: 1,
        timestamp: '2025-01-01T00:00:00.001Z',
        runId: 'run_1',
        sessionId: 'targeted',
        // `provider` and `model` are metadata; only `userInput` should be
        // scanned for turn.start. A confidential value placed in `provider`
        // must NOT be flagged.
        event: {
          type: 'turn.start',
          provider: 'Serviceplan',
          model: 'gpt-5.1',
          userInput: 'all clear here',
        },
      },
    ]);
    const report = scanAuditSessionForLeaks('targeted', RULES, tempDir);
    expect(report.totalMatches).toBe(0);
  });

  test('scanAllAuditSessionsForLeaks scans every session', () => {
    writeWireLines('alpha', [
      {
        version: '2.0',
        seq: 1,
        timestamp: '2025-01-01T00:00:00.001Z',
        runId: 'run_1',
        sessionId: 'alpha',
        event: { type: 'turn.start', content: 'Project Falcon update' },
      },
    ]);
    writeWireLines('beta', [
      {
        version: '2.0',
        seq: 1,
        timestamp: '2025-01-01T00:00:00.001Z',
        runId: 'run_1',
        sessionId: 'beta',
        event: { type: 'turn.start', content: 'Hello world' },
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
