import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config/config.js';
import {
  type ConfidentialFinding,
  type ConfidentialScanResult,
  scanForLeaks,
} from '../security/confidential-redact.js';
import type {
  ConfidentialKind,
  ConfidentialRuleSet,
} from '../security/confidential-rules.js';

const AUDIT_DIR_NAME = 'audit';
const WIRE_FILE_NAME = 'wire.jsonl';
const PLACEHOLDER_RE = /«CONF:[A-Z0-9_-]+»/;

/**
 * Where the leaking text lives relative to the LLM. Used to bucket the
 * summary so reviewers can tell at a glance whether their leaks are user
 * input, model output, tool I/O, or URL-shaped strings (which are easy
 * to fix by sanitising the URL builder).
 *
 *  - `in`   → user input that travels TO the LLM
 *  - `out`  → text the LLM emitted (or a system prompt sent on its behalf)
 *  - `tool` → tool I/O (call args + tool results, including skill steps)
 *  - `url`  → match falls inside a URL/markdown link, regardless of event
 *
 * URL is its own bucket because URLs are the most common leak surface in
 * tool output (search results, fetched pages) and the cheapest mitigation
 * is "redact URL paths" rather than "rewrite the prompt".
 */
export type PromptCategory = 'in' | 'out' | 'tool' | 'url';

/**
 * @deprecated kept as an alias during migration; prefer {@link PromptCategory}.
 */
export type PromptDirection = PromptCategory;

const EVENT_TYPE_DIRECTIONS: Record<string, Exclude<PromptCategory, 'url'>> = {
  'turn.start': 'in',
  prompt: 'in',
  message: 'in',
  'turn.end': 'out',
  text: 'out',
  thinking: 'out',
  'approval.request': 'out',
  'tool.call': 'tool',
  'tool.result': 'tool',
  'skill.execution': 'tool',
  'skill.inspection': 'tool',
};

/**
 * Per event type, the set of fields whose values carry actual prompt
 * content. Only these fields are scanned, which avoids false positives
 * from metadata fields like `provider`, `toolName`, `username`, etc.
 *
 * For `arguments` (a nested object on `tool.call`), we recurse into all
 * string values within — the schema is open-ended.
 */
const PROMPT_TEXT_FIELDS_BY_TYPE: Record<string, ReadonlyArray<string>> = {
  'turn.start': ['userInput', 'rawUserInput', 'content', 'text'],
  'turn.end': ['text', 'output', 'result', 'summary', 'response', 'content'],
  'tool.call': ['arguments'],
  'tool.result': [
    'resultSummary',
    'output',
    'result',
    'content',
    'summary',
    'text',
  ],
  'approval.request': ['description', 'reason'],
  prompt: ['content', 'text', 'system', 'systemPrompt'],
  message: ['content', 'text'],
  text: ['text', 'content'],
  thinking: ['text', 'content'],
  'skill.execution': ['prompt', 'result', 'output', 'text'],
  'skill.inspection': ['prompt', 'result', 'output', 'text'],
};

/**
 * Detects URLs and markdown link targets in scanned text. Catches:
 *  - bare URLs:                 `https://example.com/path?q=1`
 *  - markdown relative links:   `[label](/path/to/thing#anchor)`
 *  - markdown absolute links:   `[label](https://example.com)`
 */
const URL_SPAN_RE =
  /(?:https?:\/\/[^\s<>"'`]+|\]\(([^)]+)\)|\((\/[^()\s]+)\))/g;

/**
 * Event types whose payload contains text that travels to or from the LLM,
 * and is therefore worth scanning for confidential-info leaks.
 *
 * Telemetry/lifecycle/auth events are intentionally excluded — e.g.
 * `model.usage` payloads contain provider names like "HybridAI" as field
 * values, which would generate noisy false positives against a rule that
 * names HybridAI as a confidential client.
 */
export const PROMPT_BEARING_EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.keys(EVENT_TYPE_DIRECTIONS),
);

export function directionForEventType(
  eventType: string,
): Exclude<PromptCategory, 'url'> | null {
  return EVENT_TYPE_DIRECTIONS[eventType] ?? null;
}

function findUrlSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  URL_SPAN_RE.lastIndex = 0;
  let match: RegExpExecArray | null = URL_SPAN_RE.exec(text);
  while (match) {
    spans.push({ start: match.index, end: match.index + match[0].length });
    if (URL_SPAN_RE.lastIndex === match.index) URL_SPAN_RE.lastIndex += 1;
    match = URL_SPAN_RE.exec(text);
  }
  return spans;
}

function indexFallsInsideAnySpan(
  index: number,
  spans: { start: number; end: number }[],
): boolean {
  for (const span of spans) {
    if (index >= span.start && index < span.end) return true;
  }
  return false;
}

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
  /** Bucket for the summary footer: in/out/tool by event direction, or url when the match falls inside a URL/markdown link. */
  category: PromptCategory;
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

export const SEVERITY_LEVELS: ReadonlyArray<
  ConfidentialFinding['sensitivity']
> = ['low', 'medium', 'high', 'critical'];

export interface LeakReportFilter {
  /** Floor severity — keep only records whose severity is at or above this. */
  minSeverity?: ConfidentialFinding['sensitivity'];
  /** Allow-list of categories — keep only records bucketed in one of these. */
  categories?: ReadonlySet<PromptCategory>;
}

/**
 * Apply post-scan filters to reports without re-scanning the wire log.
 * Records that fail the filter are removed; per-session totals (matches,
 * raw score, score, severity) are recomputed against the surviving set.
 */
export function applyLeakReportFilter(
  reports: LeakScanReport[],
  filter: LeakReportFilter,
): LeakScanReport[] {
  const minRank = filter.minSeverity ? SEVERITY_RANK[filter.minSeverity] : null;
  const categories = filter.categories;
  if (minRank == null && !categories) return reports;

  return reports.map((report) => {
    const survivors = report.matchedRecords.filter((record) => {
      if (minRank != null && SEVERITY_RANK[record.severity] < minRank) {
        return false;
      }
      if (categories && !categories.has(record.category)) return false;
      return true;
    });
    if (survivors.length === report.matchedRecords.length) return report;

    let totalMatches = 0;
    let aggregateRaw = 0;
    let severity: ConfidentialFinding['sensitivity'] = 'low';
    for (const record of survivors) {
      totalMatches += record.totalMatches;
      aggregateRaw += record.rawScore;
      severity = rankSeverity(severity, record.severity);
    }
    const aggregate = bucketScore(aggregateRaw);
    return {
      ...report,
      matchedRecords: survivors,
      totalMatches,
      rawScore: aggregate.rawScore,
      score: aggregate.score,
      severity:
        SEVERITY_RANK[aggregate.severity] > SEVERITY_RANK[severity]
          ? aggregate.severity
          : severity,
    };
  });
}

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

function collectPromptText(
  event: Record<string, unknown>,
  fields: ReadonlyArray<string>,
): string[] {
  const out: string[] = [];
  for (const field of fields) {
    if (field in event) {
      collectStringValues(event[field], out);
    }
  }
  return out;
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
): {
  result: ConfidentialScanResult;
  hadPlaceholder: boolean;
  combinedText: string;
} | null {
  const event = record.event;
  if (!event || typeof event !== 'object') return null;
  const eventType = typeof event.type === 'string' ? event.type : '';
  const fields = PROMPT_TEXT_FIELDS_BY_TYPE[eventType];
  // Unknown event types fall back to the field whitelist union, which
  // catches the common content-bearing field names without dragging in
  // metadata like `provider`, `username`, `toolName`.
  const fallbackFields = [
    'content',
    'text',
    'output',
    'result',
    'summary',
    'description',
    'reason',
    'prompt',
    'userInput',
    'rawUserInput',
  ];
  const strings = collectPromptText(
    event as Record<string, unknown>,
    fields ?? fallbackFields,
  );
  if (strings.length === 0) return null;
  const combinedText = strings.join('\n');
  const hadPlaceholder = PLACEHOLDER_RE.test(combinedText);
  const result = scanForLeaks(combinedText, ruleSet);
  if (result.totalMatches === 0) return null;
  return { result, hadPlaceholder, combinedText };
}

function categoryForRecord(
  eventType: string,
  combinedText: string,
  findings: ConfidentialFinding[],
): PromptCategory {
  const urlSpans = findUrlSpans(combinedText);
  if (urlSpans.length > 0) {
    for (const finding of findings) {
      if (!finding.match) continue;
      const idx = combinedText.indexOf(finding.match);
      if (idx >= 0 && indexFallsInsideAnySpan(idx, urlSpans)) {
        return 'url';
      }
    }
  }
  return directionForEventType(eventType) ?? 'tool';
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
      category: categoryForRecord(
        eventType,
        scan.combinedText,
        scan.result.findings,
      ),
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

export interface CategoryTotals {
  /** Number of matched audit records bucketed in this category. */
  records: number;
  /** Sum of matches inside those records. */
  matches: number;
  /** Number of distinct sessions in which this category appeared. */
  sessions: number;
}

export interface KindTotals {
  /** Sum of finding.matches across all findings of this kind. */
  matches: number;
  /** Number of records that contain at least one finding of this kind. */
  records: number;
  /** Number of distinct sessions in which this kind appeared. */
  sessions: number;
  /** Number of distinct rule labels (e.g. distinct client names) hit. */
  distinctLabels: number;
}

const CATEGORY_KEYS: ReadonlyArray<PromptCategory> = [
  'in',
  'out',
  'tool',
  'url',
];

export const KIND_KEYS: ReadonlyArray<ConfidentialKind> = [
  'client',
  'project',
  'person',
  'keyword',
  'pattern',
];

export function summarizeLeakReports(reports: LeakScanReport[]): {
  bySeverity: Record<ConfidentialFinding['sensitivity'], number>;
  byCategory: Record<PromptCategory, CategoryTotals>;
  byKind: Record<ConfidentialKind, KindTotals>;
  /** @deprecated alias for {@link byCategory}; remove after callers migrate. */
  byDirection: Record<PromptCategory, CategoryTotals>;
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
  const byCategory: Record<PromptCategory, CategoryTotals> = {
    in: { records: 0, matches: 0, sessions: 0 },
    out: { records: 0, matches: 0, sessions: 0 },
    tool: { records: 0, matches: 0, sessions: 0 },
    url: { records: 0, matches: 0, sessions: 0 },
  };
  const sessionsSeenByCategory: Record<PromptCategory, Set<string>> = {
    in: new Set(),
    out: new Set(),
    tool: new Set(),
    url: new Set(),
  };
  const byKind: Record<ConfidentialKind, KindTotals> = {
    client: { matches: 0, records: 0, sessions: 0, distinctLabels: 0 },
    project: { matches: 0, records: 0, sessions: 0, distinctLabels: 0 },
    person: { matches: 0, records: 0, sessions: 0, distinctLabels: 0 },
    keyword: { matches: 0, records: 0, sessions: 0, distinctLabels: 0 },
    pattern: { matches: 0, records: 0, sessions: 0, distinctLabels: 0 },
  };
  const sessionsSeenByKind: Record<ConfidentialKind, Set<string>> = {
    client: new Set(),
    project: new Set(),
    person: new Set(),
    keyword: new Set(),
    pattern: new Set(),
  };
  const labelsSeenByKind: Record<ConfidentialKind, Set<string>> = {
    client: new Set(),
    project: new Set(),
    person: new Set(),
    keyword: new Set(),
    pattern: new Set(),
  };
  let totalMatches = 0;
  let affectedSessions = 0;
  for (const report of reports) {
    totalMatches += report.totalMatches;
    if (report.totalMatches > 0) {
      affectedSessions += 1;
      bySeverity[report.severity] += 1;
    }
    for (const record of report.matchedRecords) {
      const bucket = record.category;
      byCategory[bucket].records += 1;
      byCategory[bucket].matches += record.totalMatches;
      sessionsSeenByCategory[bucket].add(report.sessionId);

      const kindsInRecord = new Set<ConfidentialKind>();
      for (const finding of record.findings) {
        const kind = finding.kind as ConfidentialKind;
        byKind[kind].matches += finding.matches;
        kindsInRecord.add(kind);
        sessionsSeenByKind[kind].add(report.sessionId);
        labelsSeenByKind[kind].add(finding.label);
      }
      // A record contributes to byKind[k].records once per distinct
      // kind it touches, regardless of how many findings of that kind
      // it carries.
      for (const kind of kindsInRecord) {
        byKind[kind].records += 1;
      }
    }
  }
  for (const key of CATEGORY_KEYS) {
    byCategory[key].sessions = sessionsSeenByCategory[key].size;
  }
  for (const key of KIND_KEYS) {
    byKind[key].sessions = sessionsSeenByKind[key].size;
    byKind[key].distinctLabels = labelsSeenByKind[key].size;
  }
  return {
    bySeverity,
    byCategory,
    byKind,
    byDirection: byCategory,
    totalMatches,
    totalSessions: reports.length,
    affectedSessions,
  };
}
