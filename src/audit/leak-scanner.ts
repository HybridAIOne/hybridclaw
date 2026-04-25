import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config/config.js';
import {
  type ConfidentialFinding,
  type ConfidentialScanResult,
  scanForLeaks,
} from '../security/confidential-redact.js';
import type { ConfidentialRuleSet } from '../security/confidential-rules.js';

const AUDIT_DIR_NAME = 'audit';
const WIRE_FILE_NAME = 'wire.jsonl';
const PLACEHOLDER_RE = /«CONF:[A-Z0-9_-]+»/;

/**
 * Event types whose payload contains text that travels to or from the LLM,
 * and is therefore worth scanning for confidential-info leaks.
 *
 * Telemetry/lifecycle/auth events are intentionally excluded — e.g.
 * `model.usage` payloads contain provider names like "HybridAI" as field
 * values, which would generate noisy false positives against a rule that
 * names HybridAI as a confidential client.
 */
export const PROMPT_BEARING_EVENT_TYPES: ReadonlySet<string> = new Set([
  'turn.start',
  'turn.end',
  'tool.call',
  'tool.result',
  'approval.request',
  'prompt',
  'message',
  'text',
  'thinking',
  'skill.execution',
  'skill.inspection',
]);

function resolveScanEventTypes(): ReadonlySet<string> {
  const override = (process.env.HYBRIDCLAW_LEAK_SCAN_EVENT_TYPES || '').trim();
  if (!override) return PROMPT_BEARING_EVENT_TYPES;
  const types = override
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return types.length > 0 ? new Set(types) : PROMPT_BEARING_EVENT_TYPES;
}

export interface LeakScanRecord {
  seq: number;
  timestamp: string;
  runId: string;
  parentRunId?: string;
  eventType: string;
  findings: ConfidentialFinding[];
  totalMatches: number;
  rawScore: number;
  score: number;
  severity: ConfidentialFinding['sensitivity'];
  /** True when the source text already contained a confidential placeholder (i.e. dehydration had run). */
  hadPlaceholder: boolean;
}

export interface LeakScanReport {
  sessionId: string;
  filePath: string;
  recordsScanned: number;
  /** Number of records skipped because their event.type is not prompt-bearing. */
  recordsSkippedByType: number;
  matchedRecords: LeakScanRecord[];
  totalMatches: number;
  /** sum of per-record raw scores, capped at 1000 then normalized to 0-100 */
  rawScore: number;
  score: number;
  severity: ConfidentialFinding['sensitivity'];
  errors: string[];
}

export interface LeakScanOptions {
  /** Override the default {@link PROMPT_BEARING_EVENT_TYPES} whitelist. */
  scanEventTypes?: ReadonlySet<string>;
}

const SEVERITY_RANK: Record<ConfidentialFinding['sensitivity'], number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function rankSeverity(
  current: ConfidentialFinding['sensitivity'],
  next: ConfidentialFinding['sensitivity'],
): ConfidentialFinding['sensitivity'] {
  return SEVERITY_RANK[next] > SEVERITY_RANK[current] ? next : current;
}

function bucketScore(rawScore: number): {
  rawScore: number;
  score: number;
  severity: ConfidentialFinding['sensitivity'];
} {
  const capped = Math.min(rawScore, 1000);
  const score = Math.round((capped / 1000) * 100);
  let severity: ConfidentialFinding['sensitivity'] = 'low';
  if (capped >= 100) severity = 'critical';
  else if (capped >= 30) severity = 'high';
  else if (capped >= 10) severity = 'medium';
  return { rawScore: capped, score, severity };
}

function collectStringValues(value: unknown, into: string[]): void {
  if (value == null) return;
  if (typeof value === 'string') {
    if (value) into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStringValues(entry, into);
    return;
  }
  if (typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectStringValues(entry, into);
    }
  }
}

interface WireRecord {
  seq?: number;
  timestamp?: string;
  runId?: string;
  parentRunId?: string;
  event?: { type?: string; [key: string]: unknown };
}

function parseWireLine(line: string): WireRecord | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as WireRecord;
  } catch {
    return null;
  }
}

function scanRecordForLeaks(
  record: WireRecord,
  ruleSet: ConfidentialRuleSet,
): { result: ConfidentialScanResult; hadPlaceholder: boolean } | null {
  const event = record.event;
  if (!event || typeof event !== 'object') return null;
  const strings: string[] = [];
  collectStringValues(event, strings);
  if (strings.length === 0) return null;
  const combined = strings.join('\n');
  const hadPlaceholder = PLACEHOLDER_RE.test(combined);
  const result = scanForLeaks(combined, ruleSet);
  if (result.totalMatches === 0) return null;
  return { result, hadPlaceholder };
}

function listAuditSessionIds(auditRoot: string): string[] {
  if (!fs.existsSync(auditRoot)) return [];
  try {
    const entries = fs.readdirSync(auditRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) =>
        fs.existsSync(path.join(auditRoot, name, WIRE_FILE_NAME)),
      )
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export function listAuditedSessions(
  dataDir: string = DATA_DIR,
): { sessionId: string; filePath: string }[] {
  const auditRoot = path.join(dataDir, AUDIT_DIR_NAME);
  return listAuditSessionIds(auditRoot).map((sessionId) => ({
    sessionId,
    filePath: path.join(auditRoot, sessionId, WIRE_FILE_NAME),
  }));
}

export function scanAuditSessionForLeaks(
  sessionId: string,
  ruleSet: ConfidentialRuleSet,
  dataDir: string = DATA_DIR,
  options: LeakScanOptions = {},
): LeakScanReport {
  const scanTypes = options.scanEventTypes ?? resolveScanEventTypes();
  const safeId = sessionId.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'session';
  const filePath = path.join(dataDir, AUDIT_DIR_NAME, safeId, WIRE_FILE_NAME);
  const errors: string[] = [];

  if (!fs.existsSync(filePath)) {
    return {
      sessionId,
      filePath,
      recordsScanned: 0,
      recordsSkippedByType: 0,
      matchedRecords: [],
      totalMatches: 0,
      rawScore: 0,
      score: 0,
      severity: 'low',
      errors: [`wire log not found: ${filePath}`],
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    return {
      sessionId,
      filePath,
      recordsScanned: 0,
      recordsSkippedByType: 0,
      matchedRecords: [],
      totalMatches: 0,
      rawScore: 0,
      score: 0,
      severity: 'low',
      errors: [
        `failed to read wire log: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const matched: LeakScanRecord[] = [];
  let recordsScanned = 0;
  let recordsSkippedByType = 0;
  let totalMatches = 0;
  let aggregateRaw = 0;
  let severity: ConfidentialFinding['sensitivity'] = 'low';

  for (let i = 0; i < lines.length; i++) {
    const parsed = parseWireLine(lines[i]);
    if (!parsed || !parsed.event) continue;
    const eventType =
      typeof parsed.event?.type === 'string' ? parsed.event.type : 'unknown';
    if (!scanTypes.has(eventType)) {
      recordsSkippedByType += 1;
      continue;
    }
    recordsScanned += 1;
    const scan = scanRecordForLeaks(parsed, ruleSet);
    if (!scan) continue;

    matched.push({
      seq: typeof parsed.seq === 'number' ? parsed.seq : i,
      timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : '',
      runId: typeof parsed.runId === 'string' ? parsed.runId : '',
      parentRunId:
        typeof parsed.parentRunId === 'string' ? parsed.parentRunId : undefined,
      eventType,
      findings: scan.result.findings,
      totalMatches: scan.result.totalMatches,
      rawScore: scan.result.rawScore,
      score: scan.result.score,
      severity: scan.result.severity,
      hadPlaceholder: scan.hadPlaceholder,
    });
    totalMatches += scan.result.totalMatches;
    aggregateRaw += scan.result.rawScore;
    severity = rankSeverity(severity, scan.result.severity);
  }

  const aggregate = bucketScore(aggregateRaw);
  return {
    sessionId,
    filePath,
    recordsScanned,
    recordsSkippedByType,
    matchedRecords: matched,
    totalMatches,
    rawScore: aggregate.rawScore,
    score: aggregate.score,
    severity:
      SEVERITY_RANK[aggregate.severity] > SEVERITY_RANK[severity]
        ? aggregate.severity
        : severity,
    errors,
  };
}

export function scanAllAuditSessionsForLeaks(
  ruleSet: ConfidentialRuleSet,
  dataDir: string = DATA_DIR,
  options: LeakScanOptions = {},
): LeakScanReport[] {
  return listAuditedSessions(dataDir).map(({ sessionId }) =>
    scanAuditSessionForLeaks(sessionId, ruleSet, dataDir, options),
  );
}

export function summarizeLeakReports(reports: LeakScanReport[]): {
  bySeverity: Record<ConfidentialFinding['sensitivity'], number>;
  totalMatches: number;
  totalSessions: number;
  affectedSessions: number;
} {
  const bySeverity: Record<ConfidentialFinding['sensitivity'], number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  let totalMatches = 0;
  let affectedSessions = 0;
  for (const report of reports) {
    totalMatches += report.totalMatches;
    if (report.totalMatches > 0) {
      affectedSessions += 1;
      bySeverity[report.severity] += 1;
    }
  }
  return {
    bySeverity,
    totalMatches,
    totalSessions: reports.length,
    affectedSessions,
  };
}
