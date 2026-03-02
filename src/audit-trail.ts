import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

export const AUDIT_PROTOCOL_VERSION = '2.0';
const AUDIT_DIR_NAME = 'audit';
const WIRE_FILE_NAME = 'wire.jsonl';
const FALLBACK_PREV_HASH = 'GENESIS';

const REDACTION_PATTERNS: Array<{ match: RegExp; replace: string }> = [
  {
    match: /(KEY|TOKEN|SECRET|PASSWORD)=\S+/gi,
    replace: '$1=***REDACTED***',
  },
  {
    match: /Bearer\s+\S+/gi,
    replace: 'Bearer ***REDACTED***',
  },
  {
    match: /ghp_[A-Za-z0-9_]+/g,
    replace: 'ghp_***REDACTED***',
  },
  {
    match: /sk-[A-Za-z0-9_]+/g,
    replace: 'sk-***REDACTED***',
  },
  {
    match: /(?:postgres|mysql|mongodb):\/\/[^\s"'`]+/gi,
    replace: '***CONNECTION_STRING_REDACTED***',
  },
  {
    match: /-----BEGIN[\s\S]*?-----END[\s\S]*?-----/g,
    replace: '***PEM_REDACTED***',
  },
];

export interface AuditEventPayload {
  type: string;
  [key: string]: unknown;
}

export interface WireMetadataRecord {
  type: 'metadata';
  protocolVersion: typeof AUDIT_PROTOCOL_VERSION;
  sessionId: string;
  createdAt: string;
}

export interface WireRecord {
  version: typeof AUDIT_PROTOCOL_VERSION;
  seq: number;
  timestamp: string;
  runId: string;
  sessionId: string;
  parentRunId?: string;
  event: AuditEventPayload;
  _prevHash: string;
  _hash: string;
}

export interface AppendAuditEventInput {
  sessionId: string;
  runId: string;
  parentRunId?: string;
  event: AuditEventPayload;
}

export interface AuditVerifyResult {
  ok: boolean;
  filePath: string;
  checkedRecords: number;
  errors: string[];
  lastSeq: number;
}

interface SessionAuditState {
  filePath: string;
  seq: number;
  lastHash: string;
}

const sessionStateCache = new Map<string, SessionAuditState>();

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  const type = typeof value;

  if (type === 'string') return JSON.stringify(value);
  if (type === 'number') return Number.isFinite(value as number) ? String(value) : 'null';
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'bigint') return JSON.stringify((value as bigint).toString());
  if (type === 'undefined' || type === 'function' || type === 'symbol') return 'null';

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry === undefined ? null : entry)).join(',')}]`;
  }

  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
  for (const key of keys) {
    const raw = obj[key];
    if (raw === undefined || typeof raw === 'function' || typeof raw === 'symbol') continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(raw)}`);
  }
  return `{${parts.join(',')}}`;
}

function redactString(value: string): string {
  let next = value;
  for (const pattern of REDACTION_PATTERNS) {
    next = next.replace(pattern.match, pattern.replace);
  }
  return next;
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
  if (!value || typeof value !== 'object') return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = redactValue(raw);
  }
  return redacted;
}

function safeSessionDirName(sessionId: string): string {
  const normalized = sessionId.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  return normalized || 'session';
}

export function getAuditSessionDir(sessionId: string): string {
  return path.join(DATA_DIR, AUDIT_DIR_NAME, safeSessionDirName(sessionId));
}

export function getAuditWirePath(sessionId: string): string {
  return path.join(getAuditSessionDir(sessionId), WIRE_FILE_NAME);
}

function appendLineSync(filePath: string, line: string): void {
  const fd = fs.openSync(
    filePath,
    fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY,
    0o600,
  );
  try {
    fs.writeSync(fd, `${line}\n`, undefined, 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function computeMetadataHash(metadata: WireMetadataRecord): string {
  return sha256(stableStringify(metadata));
}

function computeWireRecordHash(record: Omit<WireRecord, '_hash'>): string {
  return sha256(stableStringify(record));
}

function readSessionStateFromDisk(sessionId: string, filePath: string): SessionAuditState {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    const metadata: WireMetadataRecord = {
      type: 'metadata',
      protocolVersion: AUDIT_PROTOCOL_VERSION,
      sessionId,
      createdAt: new Date().toISOString(),
    };
    appendLineSync(filePath, JSON.stringify(metadata));
    return {
      filePath,
      seq: 0,
      lastHash: computeMetadataHash(metadata),
    };
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    const metadata: WireMetadataRecord = {
      type: 'metadata',
      protocolVersion: AUDIT_PROTOCOL_VERSION,
      sessionId,
      createdAt: new Date().toISOString(),
    };
    appendLineSync(filePath, JSON.stringify(metadata));
    return {
      filePath,
      seq: 0,
      lastHash: computeMetadataHash(metadata),
    };
  }

  let seq = 0;
  let lastHash = FALLBACK_PREV_HASH;
  let startIndex = 0;
  try {
    const firstParsed = JSON.parse(lines[0]) as Partial<WireMetadataRecord>;
    if (firstParsed.type === 'metadata') {
      const metadata: WireMetadataRecord = {
        type: 'metadata',
        protocolVersion: AUDIT_PROTOCOL_VERSION,
        sessionId: typeof firstParsed.sessionId === 'string' ? firstParsed.sessionId : sessionId,
        createdAt: typeof firstParsed.createdAt === 'string' ? firstParsed.createdAt : new Date().toISOString(),
      };
      lastHash = computeMetadataHash(metadata);
      startIndex = 1;
    }
  } catch {
    // Existing file without metadata. Keep fallback previous hash.
  }

  for (let i = startIndex; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]) as Partial<WireRecord>;
      if (
        typeof parsed.seq === 'number'
        && Number.isFinite(parsed.seq)
        && typeof parsed._hash === 'string'
        && parsed._hash
      ) {
        seq = parsed.seq;
        lastHash = parsed._hash;
      }
    } catch {
      // Best effort; skip malformed historical lines.
    }
  }

  return { filePath, seq, lastHash };
}

function getSessionState(sessionId: string): SessionAuditState {
  const existing = sessionStateCache.get(sessionId);
  if (existing) return existing;

  const sessionDir = getAuditSessionDir(sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, WIRE_FILE_NAME);
  const state = readSessionStateFromDisk(sessionId, filePath);
  sessionStateCache.set(sessionId, state);
  return state;
}

export function createAuditRunId(prefix = 'run'): string {
  const normalized = prefix.trim().replace(/[^a-zA-Z0-9_-]/g, '') || 'run';
  return `${normalized}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

export function appendAuditEvent(input: AppendAuditEventInput): WireRecord {
  const state = getSessionState(input.sessionId);
  const seq = state.seq + 1;
  const event = redactValue(input.event) as AuditEventPayload;

  const recordWithoutHash: Omit<WireRecord, '_hash'> = {
    version: AUDIT_PROTOCOL_VERSION,
    seq,
    timestamp: new Date().toISOString(),
    runId: input.runId,
    sessionId: input.sessionId,
    parentRunId: input.parentRunId,
    event,
    _prevHash: state.lastHash,
  };

  const _hash = computeWireRecordHash(recordWithoutHash);
  const record: WireRecord = {
    ...recordWithoutHash,
    _hash,
  };

  appendLineSync(state.filePath, JSON.stringify(record));
  state.seq = seq;
  state.lastHash = _hash;
  return record;
}

function parseWireLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function verifyAuditSessionChain(sessionId: string): AuditVerifyResult {
  const filePath = getAuditWirePath(sessionId);
  const lines = parseWireLines(filePath);
  if (lines.length === 0) {
    return {
      ok: false,
      filePath,
      checkedRecords: 0,
      errors: ['Wire log not found or empty.'],
      lastSeq: 0,
    };
  }

  const errors: string[] = [];
  let expectedPrevHash = FALLBACK_PREV_HASH;
  let expectedSeq = 1;
  let checkedRecords = 0;
  let lastSeq = 0;
  let startIndex = 0;

  try {
    const first = JSON.parse(lines[0]) as Partial<WireMetadataRecord>;
    if (first.type === 'metadata') {
      const metadata: WireMetadataRecord = {
        type: 'metadata',
        protocolVersion: AUDIT_PROTOCOL_VERSION,
        sessionId: typeof first.sessionId === 'string' ? first.sessionId : sessionId,
        createdAt: typeof first.createdAt === 'string' ? first.createdAt : '',
      };
      expectedPrevHash = computeMetadataHash(metadata);
      startIndex = 1;
    }
  } catch {
    // No metadata line. Chain starts at fallback hash.
  }

  for (let i = startIndex; i < lines.length; i++) {
    const lineNo = i + 1;
    let parsed: WireRecord;
    try {
      parsed = JSON.parse(lines[i]) as WireRecord;
    } catch (err) {
      errors.push(`Line ${lineNo}: invalid JSON (${err instanceof Error ? err.message : 'parse failure'}).`);
      continue;
    }

    if (parsed.version !== AUDIT_PROTOCOL_VERSION) {
      errors.push(`Line ${lineNo}: unsupported version "${String(parsed.version)}".`);
      continue;
    }
    if (!Number.isFinite(parsed.seq) || parsed.seq <= 0) {
      errors.push(`Line ${lineNo}: invalid sequence number.`);
      continue;
    }
    if (parsed.seq !== expectedSeq) {
      errors.push(`Line ${lineNo}: expected seq ${expectedSeq}, got ${parsed.seq}.`);
    }
    if (parsed._prevHash !== expectedPrevHash) {
      errors.push(`Line ${lineNo}: previous hash mismatch.`);
    }

    const recomputedHash = computeWireRecordHash({
      version: parsed.version,
      seq: parsed.seq,
      timestamp: parsed.timestamp,
      runId: parsed.runId,
      sessionId: parsed.sessionId,
      parentRunId: parsed.parentRunId,
      event: parsed.event,
      _prevHash: parsed._prevHash,
    });
    if (parsed._hash !== recomputedHash) {
      errors.push(`Line ${lineNo}: hash mismatch.`);
    }

    checkedRecords += 1;
    lastSeq = parsed.seq;
    expectedSeq = parsed.seq + 1;
    expectedPrevHash = parsed._hash;
  }

  return {
    ok: errors.length === 0,
    filePath,
    checkedRecords,
    errors,
    lastSeq,
  };
}

export function truncateAuditText(value: string, maxChars = 280): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
