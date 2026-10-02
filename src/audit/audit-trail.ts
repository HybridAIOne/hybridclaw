/**
 * Hash-chained audit wire log (`<DATA_DIR>/audit/<session>/wire.jsonl`).
 *
 * Appends never block the event loop: they queue in call order and are
 * group-committed per session file on the libuv pool. `seq` and `_prevHash`
 * are assigned at commit time, so a failed write leaves the chain as it was,
 * and `appendAuditEvent` resolves only after its line is fsynced. Mirrors of a
 * record (the SQLite `audit_events` row in `audit-events.ts`) are written after
 * that promise resolves, never before. This module never touches SQLite.
 */
import { hash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { type FileHandle, mkdir, open } from 'node:fs/promises';
import path from 'node:path';

import { DATA_DIR } from '../config/config.js';
import { redactSecretsDeep } from '../security/redact.js';

export const AUDIT_PROTOCOL_VERSION = '2.0';
const AUDIT_DIR_NAME = 'audit';
const WIRE_FILE_NAME = 'wire.jsonl';
const FALLBACK_PREV_HASH = 'GENESIS';

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

interface QueuedAppend extends AppendAuditEventInput {
  timestamp: string;
  resolve: (record: WireRecord) => void;
  reject: (error: unknown) => void;
}

// 64 KiB: one read covers the last record of nearly every wire log.
const CHAIN_HEAD_READ_BYTES = 64 * 1024;

const sessionStateCache = new Map<string, SessionAuditState>();
let queuedAppends: QueuedAppend[] = [];
let draining = false;
let drainDone: Promise<void> = Promise.resolve();

function sha256(text: string): string {
  return hash('sha256', text, 'hex');
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  const type = typeof value;

  if (type === 'string') return JSON.stringify(value);
  if (type === 'number')
    return Number.isFinite(value as number) ? String(value) : 'null';
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'bigint') return JSON.stringify((value as bigint).toString());
  if (type === 'undefined' || type === 'function' || type === 'symbol')
    return 'null';

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry === undefined ? null : entry)).join(',')}]`;
  }

  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
  for (const key of keys) {
    const raw = obj[key];
    if (
      raw === undefined ||
      typeof raw === 'function' ||
      typeof raw === 'symbol'
    )
      continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(raw)}`);
  }
  return `{${parts.join(',')}}`;
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

async function appendLines(filePath: string, lines: string[]): Promise<void> {
  const handle = await open(
    filePath,
    fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.appendFile(`${lines.join('\n')}\n`, 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function computeMetadataHash(metadata: WireMetadataRecord): string {
  return sha256(stableStringify(metadata));
}

function computeWireRecordHash(record: Omit<WireRecord, '_hash'>): string {
  return sha256(stableStringify(record));
}

function parseChainLink(
  line: string,
): Pick<SessionAuditState, 'seq' | 'lastHash'> | null {
  try {
    const parsed = JSON.parse(line) as Partial<WireRecord>;
    if (
      typeof parsed.seq === 'number' &&
      Number.isFinite(parsed.seq) &&
      typeof parsed._hash === 'string' &&
      parsed._hash
    ) {
      return { seq: parsed.seq, lastHash: parsed._hash };
    }
  } catch {
    // Best effort; skip malformed historical lines.
  }
  return null;
}

function chainRootHash(firstLine: string, sessionId: string): string {
  try {
    const parsed = JSON.parse(firstLine) as Partial<WireMetadataRecord>;
    if (parsed.type === 'metadata') {
      return computeMetadataHash({
        type: 'metadata',
        protocolVersion: AUDIT_PROTOCOL_VERSION,
        sessionId:
          typeof parsed.sessionId === 'string' ? parsed.sessionId : sessionId,
        createdAt:
          typeof parsed.createdAt === 'string'
            ? parsed.createdAt
            : new Date().toISOString(),
      });
    }
  } catch {
    // Existing file without metadata. Keep fallback previous hash.
  }
  return FALLBACK_PREV_HASH;
}

async function* readLinesFromEnd(handle: FileHandle): AsyncGenerator<string> {
  let position = (await handle.stat()).size;
  // Bytes of the line that straddles the chunk boundary, in file order.
  let carried: Buffer[] = [];
  while (position > 0) {
    const length = Math.min(CHAIN_HEAD_READ_BYTES, position);
    position -= length;
    const chunk = Buffer.alloc(length);
    await handle.read(chunk, 0, length, position);
    let end = length;
    let newline = chunk.lastIndexOf(0x0a, end - 1);
    while (newline >= 0) {
      yield Buffer.concat([chunk.subarray(newline + 1, end), ...carried])
        .toString('utf-8')
        .trim();
      carried = [];
      end = newline;
      newline = end > 0 ? chunk.lastIndexOf(0x0a, end - 1) : -1;
    }
    carried.unshift(chunk.subarray(0, end));
  }
  yield Buffer.concat(carried).toString('utf-8').trim();
}

// Scans back from EOF, so a cold start reads one chunk instead of parsing the
// whole history. Returns null for a missing or blank file.
async function readChainHead(
  sessionId: string,
  filePath: string,
): Promise<SessionAuditState | null> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    let firstLine: string | null = null;
    for await (const line of readLinesFromEnd(handle)) {
      if (!line) continue;
      const link = parseChainLink(line);
      if (link) return { filePath, ...link };
      firstLine = line;
    }
    if (firstLine === null) return null;
    return { filePath, seq: 0, lastHash: chainRootHash(firstLine, sessionId) };
  } finally {
    await handle.close();
  }
}

async function loadSessionState(sessionId: string): Promise<SessionAuditState> {
  const existing = sessionStateCache.get(sessionId);
  if (existing) return existing;

  const sessionDir = getAuditSessionDir(sessionId);
  await mkdir(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, WIRE_FILE_NAME);
  let state = await readChainHead(sessionId, filePath);
  if (!state) {
    const metadata: WireMetadataRecord = {
      type: 'metadata',
      protocolVersion: AUDIT_PROTOCOL_VERSION,
      sessionId,
      createdAt: new Date().toISOString(),
    };
    await appendLines(filePath, [JSON.stringify(metadata)]);
    state = { filePath, seq: 0, lastHash: computeMetadataHash(metadata) };
  }
  sessionStateCache.set(sessionId, state);
  return state;
}

export function createAuditRunId(prefix = 'run'): string {
  const normalized = prefix.trim().replace(/[^a-zA-Z0-9_-]/g, '') || 'run';
  return `${normalized}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

/**
 * Queues one record and resolves with it once its line is fsynced; records
 * are chained in call order. Rejects (never throws) when the write fails.
 */
export function appendAuditEvent(
  input: AppendAuditEventInput,
): Promise<WireRecord> {
  return new Promise((resolve, reject) => {
    queuedAppends.push({
      ...input,
      event: redactSecretsDeep(input.event) as AuditEventPayload,
      timestamp: new Date().toISOString(),
      resolve,
      reject,
    });
    if (draining) return;
    draining = true;
    drainDone = drainQueuedAppends();
  });
}

/**
 * Resolves once every queued append has settled. Continuations awaiting those
 * appends (the SQLite mirror) have run by then. Used at gateway shutdown.
 */
export async function flushAuditTrail(): Promise<void> {
  while (draining) await drainDone;
}

async function drainQueuedAppends(): Promise<void> {
  try {
    while (queuedAppends.length > 0) {
      const batch = queuedAppends;
      queuedAppends = [];
      const bySession = new Map<string, QueuedAppend[]>();
      for (const entry of batch) {
        const entries = bySession.get(entry.sessionId);
        if (entries) entries.push(entry);
        else bySession.set(entry.sessionId, [entry]);
      }
      for (const [sessionId, entries] of bySession) {
        await commitSessionAppends(sessionId, entries);
      }
    }
  } finally {
    // Cleared in the same tick the queue is seen empty, so an append queued
    // by a continuation of this drain always starts the next one.
    draining = false;
  }
}

async function commitSessionAppends(
  sessionId: string,
  entries: QueuedAppend[],
): Promise<void> {
  let state: SessionAuditState;
  try {
    state = await loadSessionState(sessionId);
  } catch (error) {
    for (const entry of entries) entry.reject(error);
    return;
  }

  let { seq, lastHash } = state;
  const committed: Array<{ entry: QueuedAppend; record: WireRecord }> = [];
  const lines: string[] = [];
  for (const entry of entries) {
    try {
      const recordWithoutHash: Omit<WireRecord, '_hash'> = {
        version: AUDIT_PROTOCOL_VERSION,
        seq: seq + 1,
        timestamp: entry.timestamp,
        runId: entry.runId,
        sessionId: entry.sessionId,
        parentRunId: entry.parentRunId,
        event: entry.event,
        _prevHash: lastHash,
      };
      const record: WireRecord = {
        ...recordWithoutHash,
        _hash: computeWireRecordHash(recordWithoutHash),
      };
      lines.push(JSON.stringify(record));
      committed.push({ entry, record });
      seq = record.seq;
      lastHash = record._hash;
    } catch (error) {
      // An unserializable event fails alone; the rest chain past it.
      entry.reject(error);
    }
  }
  if (lines.length === 0) return;

  try {
    await appendLines(state.filePath, lines);
  } catch (error) {
    // Part of the batch may have landed; re-read the chain head next time.
    sessionStateCache.delete(sessionId);
    for (const { entry } of committed) entry.reject(error);
    return;
  }
  state.seq = seq;
  state.lastHash = lastHash;
  for (const { entry, record } of committed) entry.resolve(record);
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
        sessionId:
          typeof first.sessionId === 'string' ? first.sessionId : sessionId,
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
      errors.push(
        `Line ${lineNo}: invalid JSON (${err instanceof Error ? err.message : 'parse failure'}).`,
      );
      continue;
    }

    if (parsed.version !== AUDIT_PROTOCOL_VERSION) {
      errors.push(
        `Line ${lineNo}: unsupported version "${String(parsed.version)}".`,
      );
      continue;
    }
    if (!Number.isFinite(parsed.seq) || parsed.seq <= 0) {
      errors.push(`Line ${lineNo}: invalid sequence number.`);
      continue;
    }
    if (parsed.seq !== expectedSeq) {
      errors.push(
        `Line ${lineNo}: expected seq ${expectedSeq}, got ${parsed.seq}.`,
      );
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

export function readAuditString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

export function readAuditNumber(
  payload: Record<string, unknown>,
  key: string,
): number | null {
  const value = payload[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

export function readAuditBoolean(
  payload: Record<string, unknown>,
  key: string,
): boolean | null {
  const value = payload[key];
  return typeof value === 'boolean' ? value : null;
}
